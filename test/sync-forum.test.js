'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sourceClient, collectCategories, collectGroups, syncSnapshot, validatePrivileges } = require('./sync-scripts/sync-forum');

const emptyMatrix = () => ({ groups: [], users: [] });

function fakeLocal() {
	const state = {
		categories: [{ cid: 1, parentCid: 0, name: 'Existing' }],
		categoryMap: {},
		groups: new Map([['staff', { members: new Set() }], ['local-only', { members: new Set() }]]),
		privileges: new Map([['1:groups:read:staff', true], ['1:groups:read:local-only', true]]),
		plugins: new Map([['nodebb-plugin-webhooks', true]]),
		users: new Map([['matched', 42]]),
	};
	const local = {
		state,
		ephemeralGroups: ['guests', 'spiders', 'fediverse'],
		listCategories: async () => state.categories.map(item => ({ ...item })),
		categoryMap: async () => ({ ...state.categoryMap }),
		saveCategoryMap: async (id, cid) => { state.categoryMap[id] = cid; },
		groupExists: async name => state.groups.has(name),
		createGroup: async group => { state.groups.set(group.name, { members: new Set() }); },
		updateGroup: async (name, values) => { state.groups.get(name).values = values; },
		uidByUsername: async name => state.users.get(name) || 0,
		createUser: async name => {
			const uid = 50 + state.users.size;
			state.users.set(name, uid);
			return uid;
		},
		isMember: async (name, uid) => state.groups.get(name).members.has(uid),
		joinGroup: async (name, uid) => { state.groups.get(name).members.add(uid); },
		createCategory: async values => {
			const item = { ...values, cid: state.categories.length + 1 };
			state.categories.push(item);
			return item;
		},
		updateCategory: async (cid, values) => Object.assign(state.categories.find(item => item.cid === cid), values),
		hasPrivilege: async (cid, key, principal) => state.privileges.get(`${cid}:${key}:${principal}`) || false,
		setPrivilege: async (cid, key, principal, granted) => { state.privileges.set(`${cid}:${key}:${principal}`, granted); },
		pluginInstalled: async id => state.plugins.has(id),
		pluginCompatible: async () => true,
		installCompatiblePlugin: async id => { state.plugins.set(id, false); return true; },
		setPluginActive: async (id, active) => { state.plugins.set(id, active); },
	};
	return local;
}

function fixture() {
	return {
		categories: [{
			cid: 20, parentCid: 0, name: 'Existing', values: { name: 'Existing' },
			privileges: { groups: [{ name: 'staff', privileges: { 'groups:read': false, 'groups:find': true } }], users: [] },
		}, {
			cid: 21, parentCid: 20, name: 'Child', values: { name: 'Child' }, privileges: emptyMatrix(),
		}],
		groups: [{ name: 'staff', system: false, values: { description: 'Staff' }, members: ['matched', 'missing'] }],
		globalPrivileges: emptyMatrix(),
		adminPrivileges: emptyMatrix(),
		plugins: [
			{ id: 'nodebb-plugin-webhooks', active: true },
			{ id: 'nodebb-plugin-poll', active: true },
		],
	};
}

test('dry run makes no writes; apply merges, maps and preserves local-only data', async () => {
	const local = fakeLocal();
	const before = structuredClone(local.state);
	const dry = await syncSnapshot(fixture(), local, false, () => {});
	assert.deepEqual(local.state, before);
	assert.equal(dry.missingUsers, 1);
	assert.ok(dry.warnings.includes('Missing users: "missing"'));
	assert.equal(dry.memberships, 1);

	await syncSnapshot(fixture(), local, true, () => {});
	assert.equal(local.state.categoryMap[20], 1);
	assert.equal(local.state.categoryMap[21], 2);
	assert.equal(local.state.categories[1].parentCid, 1);
	assert.equal(local.state.privileges.get('1:groups:read:staff'), false);
	assert.equal(local.state.privileges.get('1:groups:find:staff'), true);
	assert.equal(local.state.privileges.get('1:groups:read:local-only'), true);
	assert.ok(local.state.groups.get('staff').members.has(42));
	assert.equal(local.state.plugins.get('nodebb-plugin-webhooks'), false);
	assert.equal(local.state.plugins.get('nodebb-plugin-poll'), true);

	const repeat = await syncSnapshot(fixture(), local, true, () => {});
	assert.equal(repeat.memberships, 0);
	assert.equal(repeat.privileges, 0);
	assert.equal(local.state.categories.length, 2);
});

test('rejects ambiguous local categories and malformed privilege matrices', async () => {
	const local = fakeLocal();
	local.state.categories.push({ cid: 3, parentCid: 0, name: 'Existing' });
	await assert.rejects(syncSnapshot(fixture(), local, false, () => {}), /Ambiguous/);
	assert.throws(() => validatePrivileges({
		groups: [{ name: 'staff', privileges: { 'groups:read': 'false' } }], users: [],
	}), /Invalid production privilege/);
});

test('enumerates paginated categories and decodes escaped category fields', async () => {
	const matrix = emptyMatrix();
	const get = async (route, query) => {
		if (route === '/api/admin/manage/categories') {
			if (query.cid === 0) {
				return { pagination: { pageCount: 1 }, categoriesTree: [{ cid: 7, parentCid: 0, name: 'A &amp; B', description: 'C &amp; D' }] };
			}
			return { pagination: { pageCount: 1 }, categoriesTree: [{ cid: 7, children: [] }] };
		}
		if (route === '/api/admin/manage/categories/7') {
			return { category: { cid: 7, link: '/a?a=1&amp;b=2', tagWhitelist: [] } };
		}
		if (route === '/api/admin/manage/privileges/7') {
			return { privileges: matrix };
		}
		throw new Error(`Unexpected route: ${route}`);
	};
	const categories = await collectCategories(get, value => value.replaceAll('&amp;', '&'));
	assert.equal(categories[0].name, 'A & B');
	assert.equal(categories[0].values.description, 'C & D');
	assert.equal(categories[0].values.link, '/a?a=1&b=2');
});

test('rejects incomplete group membership instead of silently syncing partial data', async () => {
	const get = async route => route === '/api/admin/manage/groups' ?
		{ pagination: { pageCount: 1 }, groups: [{ name: 'staff', slug: 'staff', memberCount: 2, system: 0 }] } :
		{ pagination: { pageCount: 1 }, users: [{ username: 'one' }] };
	await assert.rejects(collectGroups(get, value => value), /Incomplete membership/);
});

test('production requests are GET-only, fixed to the read API, and do not follow redirects', async () => {
	const original = global.fetch;
	const requests = [];
	global.fetch = async (url, options) => {
		requests.push({ url: String(url), options });
		return new Response(JSON.stringify({ ok: true }));
	};
	try {
		const get = await sourceClient('test-key');
		await get('/api/admin/config');
		assert.equal(requests[0].url, 'https://fusionauth.io/community/forum/api/admin/config');
		assert.equal(requests[0].options.method, 'GET');
		assert.equal(requests[0].options.redirect, 'error');
		await assert.rejects(get('/api/../../admin/config'), /escaped/);
		assert.equal(requests.length, 1);
	} finally {
		global.fetch = original;
	}
});

test('does not activate an incompatible installed plugin', async () => {
	const local = fakeLocal();
	local.state.plugins.set('nodebb-plugin-poll', true);
	local.pluginCompatible = async id => id !== 'nodebb-plugin-poll';
	await syncSnapshot(fixture(), local, true, () => {});
	assert.equal(local.state.plugins.get('nodebb-plugin-poll'), false);
});

test('optionally imports missing users once and applies their memberships and privileges', async () => {
	const local = fakeLocal();
	const snapshot = fixture();
	snapshot.globalPrivileges.users.push({ username: 'missing', privileges: { 'chat:use': true } });
	const before = structuredClone(local.state);
	const preview = await syncSnapshot(snapshot, local, false, () => {}, true);
	assert.deepEqual(local.state, before);
	assert.equal(preview.missingUsers, 1);
	assert.equal(preview.memberships, 2);

	await syncSnapshot(snapshot, local, true, () => {}, true);
	const uid = local.state.users.get('missing');
	assert.ok(uid);
	assert.ok(local.state.groups.get('staff').members.has(uid));
	assert.equal(local.state.privileges.get(`0:chat:use:${uid}`), true);
	assert.equal(local.state.users.get('matched'), 42);

	const repeat = await syncSnapshot(snapshot, local, true, () => {}, true);
	assert.equal(repeat.missingUsers, 0);
	assert.equal(local.state.users.size, 2);
});
