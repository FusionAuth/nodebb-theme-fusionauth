#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE = 'https://fusionauth.io/community/forum';
const MAP_KEY = 'fusionauth-sync:category-map';
const SAFE_PLUGINS = new Set([
	'nodebb-plugin-composer-default',
	'nodebb-plugin-dbsearch',
	'nodebb-plugin-emoji',
	'nodebb-plugin-markdown',
	'nodebb-plugin-mentions',
	'nodebb-plugin-poll',
	'nodebb-rewards-essentials',
	'nodebb-widget-essentials',
]);
const CATEGORY_FIELDS = [
	'name', 'description', 'icon', 'color', 'bgColor', 'disabled', 'order',
	'link', 'class', 'imageClass', 'isSection', 'numRecentReplies',
	'subCategoriesPerPage', 'minTags', 'maxTags', 'postQueue',
];
const GROUP_FIELDS = [
	'description', 'icon', 'labelColor', 'textColor', 'userTitle',
	'userTitleEnabled', 'private', 'hidden', 'disableJoinRequests', 'disableLeave',
];

function assertArray(value, label) {
	if (!Array.isArray(value)) {
		throw new Error(`Invalid source response: ${label} is not an array.`);
	}
	return value;
}

function pageCount(data) {
	const count = Number(data.pagination?.pageCount);
	if (!Number.isInteger(count) || count < 0 || count > 10000) {
		throw new Error('Invalid source pagination.');
	}
	return Math.max(1, count);
}

function pick(object, fields) {
	return Object.fromEntries(fields.filter(key => object[key] !== undefined && object[key] !== null)
		.map(key => [key, object[key]]));
}

async function sourceClient(apiKey) {
	if (!apiKey) {
		throw new Error('Set NODEBB_SOURCE_API_KEY to a production administrator API key.');
	}
	return async function get(route, query = {}) {
		if (!route.startsWith('/api/')) {
			throw new Error('Only production read API paths are allowed.');
		}
		const url = new URL(`${SOURCE}${route}`);
		if (url.origin !== new URL(SOURCE).origin || !url.pathname.startsWith('/community/forum/api/')) {
			throw new Error('Production request escaped the read API.');
		}
		Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
		const response = await fetch(url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${apiKey}` },
			redirect: 'error',
			signal: AbortSignal.timeout(30000),
		});
		if (!response.ok) {
			throw new Error(`Production read failed: HTTP ${response.status} for ${url.pathname}.`);
		}
		const chunks = [];
		let length = 0;
		for await (const chunk of response.body) {
			length += chunk.length;
			if (length > 8 * 1024 * 1024) {
				throw new Error(`Production response too large: ${url.pathname}.`);
			}
			chunks.push(chunk);
		}
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	};
}

async function collectCategories(get, decode) {
	const result = [];
	const queue = [0];
	const seen = new Set();
	while (queue.length) {
		const parent = queue.shift();
		let pages = 1;
		for (let page = 1; page <= pages; page += 1) {
			const data = await get('/api/admin/manage/categories', { cid: parent, page });
			pages = pageCount(data);
			const tree = assertArray(data.categoriesTree, 'categoriesTree');
			let children = tree;
			if (parent) {
				if (tree.length !== 1 || Number(tree[0].cid) !== parent) {
					throw new Error(`Could not enumerate children of category ${parent}.`);
				}
				children = assertArray(tree[0].children, 'category children');
			}
			for (const item of children) {
				const cid = Number(item.cid);
				if (!Number.isSafeInteger(cid) || cid <= 0 || seen.has(cid) ||
					Number(item.parentCid || 0) !== parent || typeof item.name !== 'string') {
					throw new Error('Invalid or duplicate production category.');
				}
				seen.add(cid);
				queue.push(cid);
				result.push({
					cid, parentCid: parent, name: decode(item.name),
					description: typeof item.description === 'string' ? decode(item.description) : item.description,
				});
				if (result.length > 10000) {
					throw new Error('Production has too many categories to sync safely.');
				}
			}
		}
	}
	for (const item of result) {
		const data = await get(`/api/admin/manage/categories/${item.cid}`);
		if (!data.category || Number(data.category.cid) !== item.cid) {
			throw new Error(`Missing production category details for ${item.cid}.`);
		}
		item.values = { ...pick(data.category, CATEGORY_FIELDS), name: item.name };
		for (const key of ['color', 'bgColor', 'link', 'class', 'imageClass']) {
			if (typeof item.values[key] === 'string') {
				item.values[key] = decode(item.values[key]);
			}
		}
		if (typeof item.description === 'string') {
			item.values.description = item.description;
		}
		if (Array.isArray(data.category.tagWhitelist)) {
			if (!data.category.tagWhitelist.every(tag => typeof tag === 'string')) {
				throw new Error(`Unsupported tag whitelist for category ${item.cid}.`);
			}
			item.values.tagWhitelist = data.category.tagWhitelist.join(',');
		}
		item.privileges = (await get(`/api/admin/manage/privileges/${item.cid}`)).privileges;
	}
	return result;
}

async function collectGroups(get, decode) {
	const groups = [];
	let pages = 1;
	for (let page = 1; page <= pages; page += 1) {
		const data = await get('/api/admin/manage/groups', { page });
		pages = pageCount(data);
		for (const group of assertArray(data.groups, 'groups')) {
			if (typeof group.name !== 'string' || typeof group.slug !== 'string' ||
				!Number.isSafeInteger(Number(group.memberCount)) || Number(group.memberCount) < 0) {
				throw new Error('Invalid production group.');
			}
			if (groups.some(existing => existing.name === group.name)) {
				throw new Error('Duplicate production group.');
			}
			const members = [];
			let memberPages = 1;
			for (let memberPage = 1; memberPage <= memberPages; memberPage += 1) {
				const data = await get(`/api/groups/${encodeURIComponent(group.slug)}/members`, { page: memberPage });
				memberPages = pageCount(data);
				for (const member of assertArray(data.users, 'group members')) {
					if (typeof member.username !== 'string' || !member.username) {
						throw new Error('A production group member is missing a username.');
					}
					members.push(member.username);
				}
			}
			if (members.length !== Number(group.memberCount) || new Set(members).size !== members.length) {
				throw new Error(`Incomplete membership data for group ${group.name}.`);
			}
			const values = pick(group, GROUP_FIELDS);
			for (const key of ['description', 'icon', 'labelColor', 'textColor', 'userTitle']) {
				if (typeof values[key] === 'string') {
					values[key] = decode(values[key]);
				}
			}
			groups.push({ name: group.name, system: Boolean(Number(group.system)), values, members });
		}
	}
	return groups;
}

function validatePrivileges(matrix) {
	if (!matrix || !Array.isArray(matrix.groups) || !Array.isArray(matrix.users)) {
		throw new Error('Invalid production privilege matrix.');
	}
	for (const [kind, entries] of [['group', matrix.groups], ['user', matrix.users]]) {
		for (const entry of entries) {
			if (typeof (kind === 'group' ? entry.name : entry.username) !== 'string' ||
				!entry.privileges || typeof entry.privileges !== 'object' ||
				Array.isArray(entry.privileges)) {
				throw new Error('Invalid production privilege principal.');
			}
			for (const [key, value] of Object.entries(entry.privileges)) {
				if (!/^[a-z0-9][a-z0-9:_-]*$/i.test(key) || typeof value !== 'boolean' ||
					(kind === 'group') !== key.startsWith('groups:')) {
					throw new Error(`Invalid production privilege key: ${key}`);
				}
			}
		}
	}
	return matrix;
}

async function collectSnapshot(get, decode) {
	const [categories, groups, global, admin, pluginData] = await Promise.all([
		collectCategories(get, decode),
		collectGroups(get, decode),
		get('/api/admin/manage/privileges'),
		get('/api/admin/manage/privileges/admin'),
		get('/api/admin/extend/plugins'),
	]);
	for (const category of categories) {
		validatePrivileges(category.privileges);
	}
	const plugins = assertArray(pluginData.installed, 'installed plugins')
		.filter(plugin => !plugin.isTheme && !plugin.id?.startsWith('nodebb-theme-'))
		.map(plugin => {
			if (typeof plugin.id !== 'string' || !/^(@[\w-]+\/)?nodebb-(plugin|widget|rewards)-[\w-]+$/.test(plugin.id) ||
				typeof plugin.active !== 'boolean') {
				throw new Error('Invalid production plugin data.');
			}
			return { id: plugin.id, active: plugin.active };
		});
	return {
		categories,
		groups,
		globalPrivileges: validatePrivileges(global.privileges),
		adminPrivileges: validatePrivileges(admin.privileges),
		plugins,
	};
}

async function syncSnapshot(snapshot, local, apply, log = console.log, importUsers = false) {
	const report = { categories: 0, groups: 0, memberships: 0, privileges: 0, missingUsers: 0, plugins: 0, warnings: [] };
	const categories = await local.listCategories();
	const savedMap = await local.categoryMap();
	const ids = new Map([[0, 0]]);
	const used = new Set();
	const users = new Map();
	const missingUsers = new Set();
	async function localUid(username) {
		if (!users.has(username)) {
			let uid = await local.uidByUsername(username);
			if (!uid) {
				missingUsers.add(username);
				if (importUsers) {
					log(`${apply ? 'Create' : 'Would create'} local user: ${JSON.stringify(username)}`);
					uid = apply ? await local.createUser(username) : -missingUsers.size;
				}
			}
			users.set(username, uid || null);
		}
		return users.get(username);
	}

	for (const group of snapshot.groups) {
		const exists = await local.groupExists(group.name);
		if (!exists && group.system) {
			report.warnings.push(`System group not present locally: ${group.name}`);
			continue;
		}
		log(`${exists ? 'Update' : 'Create'} group: ${group.name}`);
		if (apply) {
			if (!exists) {
				await local.createGroup(group);
			}
			await local.updateGroup(group.name, group.values);
		}
		report.groups += 1;
		for (const username of group.members) {
			const uid = await localUid(username);
			if (uid && (!exists || !await local.isMember(group.name, uid))) {
				if (apply) {
					await local.joinGroup(group.name, uid);
				}
				report.memberships += 1;
			}
		}
	}

	for (const category of snapshot.categories) {
		const parent = ids.get(category.parentCid);
		if (parent === undefined) {
			throw new Error(`Production category ${category.cid} has an unresolved parent.`);
		}
		let cid = savedMap[String(category.cid)];
		if (cid && !categories.some(item => String(item.cid) === String(cid))) {
			throw new Error(`Saved local category mapping for ${category.cid} no longer exists.`);
		}
		if (!cid && Number(parent) >= 0) {
			const matches = categories.filter(item => String(item.parentCid || 0) === String(parent) && item.name === category.name);
			if (matches.length > 1) {
				throw new Error(`Ambiguous local category name: ${category.name}`);
			}
			cid = matches[0]?.cid;
		}
		if (cid && used.has(String(cid))) {
			throw new Error(`Multiple production categories match local category ${cid}.`);
		}
		log(`${cid ? 'Update' : 'Create'} category: ${category.name}`);
		const values = { ...category.values, parentCid: parent };
		if (apply) {
			if (!cid) {
				cid = (await local.createCategory(values)).cid;
				categories.push({ cid, parentCid: parent, name: category.name });
			}
			await local.updateCategory(cid, values);
			await local.saveCategoryMap(category.cid, cid);
		} else if (!cid) {
			cid = -category.cid;
		}
		used.add(String(cid));
		ids.set(category.cid, cid);
		report.categories += 1;
	}

	async function syncPrivileges(matrix, cid) {
		for (const [kind, entries] of [['group', matrix.groups], ['user', matrix.users]]) {
			for (const entry of entries) {
				const principal = kind === 'group' ? entry.name : await localUid(entry.username);
				if (!principal) {
					continue;
				}
				if (kind === 'group' && !await local.groupExists(principal) && !local.ephemeralGroups.includes(principal)) {
					const planned = snapshot.groups.some(group => group.name === principal && !group.system);
					if (!planned || apply) {
						report.warnings.push(`Privilege group not present locally: ${principal}`);
						continue;
					}
				}
				for (const [key, granted] of Object.entries(entry.privileges)) {
					if (Number(cid) < 0 || await local.hasPrivilege(cid, key, principal) !== granted) {
						if (apply) {
							await local.setPrivilege(cid, key, principal, granted);
						}
						report.privileges += 1;
					}
				}
			}
		}
	}
	await syncPrivileges(snapshot.globalPrivileges, 0);
	await syncPrivileges(snapshot.adminPrivileges, 0);
	for (const category of snapshot.categories) {
		await syncPrivileges(category.privileges, ids.get(category.cid));
	}

	for (const plugin of snapshot.plugins) {
		const installed = await local.pluginInstalled(plugin.id);
		const safeToActivate = SAFE_PLUGINS.has(plugin.id);
		if (plugin.active && !safeToActivate) {
			report.warnings.push(`Integration or unreviewed plugin will remain disabled: ${plugin.id}`);
		}
		const compatible = installed ? await local.pluginCompatible(plugin.id) : null;
		if (installed && !compatible) {
			report.warnings.push(`Installed plugin is incompatible or lacks compatibility metadata: ${plugin.id}`);
		}
		log(`${installed ? 'Check' : 'Install compatible'} plugin: ${plugin.id}` +
			`${plugin.active && safeToActivate && compatible !== false ? ' (active if compatible)' : ' (disabled)'}`);
		if (apply) {
			if (!installed && !await local.installCompatiblePlugin(plugin.id)) {
				report.warnings.push(`No compatible local version available: ${plugin.id}`);
				continue;
			}
			const valid = installed ? compatible : await local.pluginCompatible(plugin.id);
			if (!valid && !installed) {
				report.warnings.push(`Installed plugin is incompatible or lacks compatibility metadata: ${plugin.id}`);
			}
			await local.setPluginActive(plugin.id, plugin.active && safeToActivate && valid);
		}
		report.plugins += 1;
	}
	report.missingUsers = missingUsers.size;
	if (report.missingUsers) {
		const action = importUsers ? (apply ? 'were created locally' : 'would be created locally') :
			'are absent locally; memberships and user privileges were skipped';
		report.warnings.push(`${report.missingUsers} production users ${action}.`);
		report.warnings.push(`Missing users: ${Array.from(missingUsers).sort().map(name => JSON.stringify(name)).join(', ')}`);
	}
	return report;
}

async function localAdapter(importPassword) {
	const nconf = require('/usr/src/app/node_modules/nconf');
	nconf.env({ separator: '__' });
	const prestart = require('/usr/src/app/src/prestart');
	prestart.setupWinston();
	prestart.loadConfig('/opt/config/config.json');
	const url = new URL(nconf.get('url'));
	if (!['localhost', '127.0.0.1'].includes(url.hostname) || nconf.get('database') !== 'redis' ||
		nconf.get('redis:host') !== 'redis') {
		throw new Error('Refusing to write: the container is not configured for the local Docker forum.');
	}
	const db = require('/usr/src/app/src/database');
	const meta = require('/usr/src/app/src/meta');
	const categories = require('/usr/src/app/src/categories');
	const groups = require('/usr/src/app/src/groups');
	const user = require('/usr/src/app/src/user');
	const slugify = require('/usr/src/app/src/slugify');
	const privileges = require('/usr/src/app/src/privileges');
	const plugins = require('/usr/src/app/src/plugins');
	const semver = require('/usr/src/app/node_modules/semver');
	const version = require('/usr/src/app/install/package.json').version;
	await db.init();
	await meta.configs.init();
	async function validateUser(username) {
		if (username !== username.trim() || await meta.slugTaken(username)) {
			throw new Error(`Cannot create local user with an exact username: ${JSON.stringify(username)}`);
		}
		const userslug = slugify(username);
		await user.isDataValid({ username, userslug });
		return userslug;
	}
	return {
		ephemeralGroups: groups.ephemeralGroups,
		close: () => db.close(),
		listCategories: async () => categories.getCategoriesFields(await categories.getAllCidsFromSet('categories:cid'), ['cid', 'name', 'parentCid']),
		categoryMap: async () => await db.getObject(MAP_KEY) || {},
		saveCategoryMap: (sourceCid, cid) => db.setObjectField(MAP_KEY, String(sourceCid), cid),
		groupExists: name => groups.exists(name),
		createGroup: group => groups.create({ name: group.name, ...group.values }),
		updateGroup: (name, values) => groups.update(name, { ...values }),
		uidByUsername: name => user.getUidByUsername(name),
		validateUser,
		createUser: async username => {
			await validateUser(username);
			const strength = meta.config.minimumPasswordStrength;
			try {
				// Only this one-off process relaxes the strength check; the forum setting is unchanged.
				meta.config.minimumPasswordStrength = 0;
				const uid = await user.create({ username, password: importPassword }, { emailVerification: 'skip' });
				if (await user.getUserField(uid, 'username') !== username) {
					throw new Error(`NodeBB renamed imported user ${JSON.stringify(username)} (uid ${uid}).`);
				}
				return uid;
			} finally {
				meta.config.minimumPasswordStrength = strength;
			}
		},
		isMember: (name, uid) => groups.isMember(uid, name),
		joinGroup: (name, uid) => groups.join(name, uid),
		createCategory: values => categories.create({ ...values }),
		updateCategory: (cid, values) => categories.update({ [cid]: { ...values } }),
		hasPrivilege: (cid, key, principal) => groups.isMember(principal, `cid:${cid}:privileges:${key}`),
		setPrivilege: (cid, key, principal, granted) => (
			granted ? privileges.categories.give([key], cid, [principal]) : privileges.categories.rescind([key], cid, [principal])
		),
		pluginInstalled: id => plugins.isInstalled(id),
		pluginCompatible: id => {
			let pkg;
			try {
				pkg = require(path.join('/usr/src/app/node_modules', id, 'package.json'));
			} catch (error) {
				if (error.code === 'MODULE_NOT_FOUND' || error instanceof SyntaxError) {
					return false;
				}
				throw error;
			}
			const range = pkg.nbbpm?.compatibility;
			return typeof range === 'string' && Boolean(semver.validRange(range)) && semver.satisfies(version, range);
		},
		installCompatiblePlugin: async id => {
			const suggestion = await plugins.suggest(id, version);
			if (!suggestion.version || !semver.valid(suggestion.version)) {
				return false;
			}
			await plugins.toggleInstall(id, suggestion.version, 'install');
			return true;
		},
		setPluginActive: async (id, active) => {
			if (await plugins.isActive(id) !== active) {
				await plugins.toggleActive(id, active);
			}
		},
	};
}

async function inside(apply, importUsers) {
	const get = await sourceClient(process.env.NODEBB_SOURCE_API_KEY);
	const importPassword = process.env.NODEBB_IMPORT_PASSWORD;
	delete process.env.NODEBB_IMPORT_PASSWORD;
	if (apply && importUsers && !importPassword) {
		throw new Error('Set NODEBB_IMPORT_PASSWORD for local user creation.');
	}
	const { decodeHTML } = require('/usr/src/app/node_modules/entities');
	console.log('Reading production configuration (GET requests only)...');
	const snapshot = await collectSnapshot(get, decodeHTML);
	delete process.env.NODEBB_SOURCE_API_KEY;
	const local = await localAdapter(importPassword);
	try {
		const report = await syncSnapshot(snapshot, local, apply, console.log, importUsers);
		console.log(`${apply ? 'Applied' : 'Dry run'}: ${report.categories} categories, ${report.groups} groups, ` +
			`${report.memberships} memberships, ${report.privileges} privilege changes, ${report.plugins} plugins.`);
		for (const warning of report.warnings) {
			console.warn(`Warning: ${warning}`);
		}
		console.log('Category and group images, group owners, and production plugin settings are not copied.');
	} finally {
		await local.close();
	}
}

async function restartLocalNodebb(root) {
	const restart = spawnSync('docker', ['compose', '-f', 'test/compose.yaml', 'restart', 'nodebb'], {
		cwd: root, stdio: 'inherit',
	});
	if (restart.error || restart.status !== 0) {
		throw restart.error || new Error('Local NodeBB restart failed; changes have already been applied.');
	}
	const deadline = Date.now() + 180000;
	let lastError = 'no response';
	while (Date.now() < deadline) {
		try {
			const response = await fetch('http://127.0.0.1:4567/api/config', { signal: AbortSignal.timeout(3000) });
			if (response.ok) {
				console.log('Local NodeBB is responding.');
				return;
			}
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error.message;
		}
		await new Promise(resolve => setTimeout(resolve, 2000));
	}
	throw new Error(`Local NodeBB did not become ready after restart: ${lastError}`);
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some(arg => !['--apply', '--import-users', '--inside-container'].includes(arg))) {
		throw new Error('Usage: node test/sync-scripts/sync-forum.js [--apply] [--import-users]');
	}
	const apply = args.includes('--apply');
	const importUsers = args.includes('--import-users');
	if (args.includes('--inside-container')) {
		await inside(apply, importUsers);
		return;
	}
	if (!process.env.NODEBB_SOURCE_API_KEY) {
		throw new Error('Set NODEBB_SOURCE_API_KEY to a production administrator API key.');
	}
	if (apply && importUsers && !process.env.NODEBB_IMPORT_PASSWORD) {
		throw new Error('Set NODEBB_IMPORT_PASSWORD for local user creation.');
	}
	const root = path.resolve(__dirname, '../..');
	const command = ['compose', '-f', 'test/compose.yaml', 'exec', '-T', '-e', 'NODEBB_SOURCE_API_KEY',
		...(apply && importUsers ? ['-e', 'NODEBB_IMPORT_PASSWORD'] : []),
		'nodebb', 'node', '-', '--inside-container', ...(apply ? ['--apply'] : []),
		...(importUsers ? ['--import-users'] : [])];
	const result = spawnSync('docker', command, {
		cwd: root,
		input: fs.readFileSync(__filename),
		stdio: ['pipe', 'inherit', 'inherit'],
	});
	if (result.error || result.status !== 0) {
		throw result.error || new Error(`Local sync failed (status ${result.status}); local changes may be partial.`);
	}
	if (apply) {
		await restartLocalNodebb(root);
	}
}

module.exports = { sourceClient, collectSnapshot, collectCategories, collectGroups, syncSnapshot, validatePrivileges, localAdapter, restartLocalNodebb };

if (require.main === module || (process.argv[1] === '-' && process.argv.includes('--inside-container'))) {
	main().then(() => {
		if (process.argv.includes('--inside-container')) {
			process.exit(0);
		}
	}).catch(error => {
		console.error(`Forum sync failed: ${error.message}`);
		if (process.argv.includes('--inside-container')) {
			process.exit(1);
		}
		process.exitCode = 1;
	});
}
