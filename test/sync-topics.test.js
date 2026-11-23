'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { collectCategoryTopics, collectTopic, syncTopics } = require('./sync-scripts/sync-topics');

function fixture() {
	const categories = [{ cid: 1 }, { cid: 2 }, { cid: 3 }];
	const lists = new Map(categories.map(({ cid }) => [cid, Array.from({ length: cid === 3 ? 2 : 45 }, (_, i) => ({
		cid, tid: cid * 1000 + i + 1, timestamp: 10000 - i,
		pinned: i === 44 ? 1 : 0, deleted: 0,
	}))]));
	const rawReads = [];
	const get = async (route, query) => {
		const category = route.match(/^\/api\/category\/(\d+)$/);
		if (category) {
			const cid = Number(category[1]);
			const all = lists.get(cid).slice().sort((a, b) => b.pinned - a.pinned || b.timestamp - a.timestamp);
			const start = (query.page - 1) * 10;
			return { cid, topics: all.slice(start, start + 10), pagination: { pageCount: Math.ceil(all.length / 10) } };
		}
		const match = route.match(/^\/api\/topic\/(\d+)$/);
		if (match) {
			const tid = Number(match[1]);
			const cid = Math.floor(tid / 1000);
			const mainPid = tid * 10;
			return {
				tid, cid, titleRaw: `Topic ${tid}`, timestamp: 90, mainPid, postcount: 2, deleted: 0,
				pagination: { pageCount: 1 },
				posts: [
					{ pid: mainPid, tid, uid: 1, timestamp: 100, user: { username: 'existing' } },
					{ pid: mainPid + 1, tid, uid: 2, timestamp: 200, toPid: mainPid, user: { username: 'new' } },
				],
			};
		}
		const raw = route.match(/^\/api\/post\/(\d+)\/raw$/);
		if (raw) {
			const pid = Number(raw[1]);
			rawReads.push(pid);
			return { pid, content: `raw ${pid}` };
		}
		throw new Error(`Unexpected route: ${route}`);
	};
	return { categories, lists, get, rawReads };
}

function fakeLocal() {
	const state = {
		users: new Map([['existing', 10]]), topics: new Map(), posts: new Map(),
		order: [], nextTid: 1, nextPid: 1,
	};
	return {
		state,
		categoryMap: async () => ({ 1: 11, 2: 12, 3: 13 }),
		listCategories: async () => [{ cid: 11 }, { cid: 12 }, { cid: 13 }],
		uidByUsername: async username => state.users.get(username) || 0,
		validateUser: async username => username,
		createUser: async username => { state.users.set(username, 20); return 20; },
		topicState: async tid => state.topics.get(tid)?.tid || null,
		postState: async pid => state.posts.get(pid)?.pid || null,
		createTopic: async (topic, cid, uid, timestamp) => {
			const tid = state.nextTid++;
			state.topics.set(topic.tid, { tid, cid, uid, timestamp, title: topic.title });
			state.order.push(topic.tid);
			return tid;
		},
		createPost: async (post, tid, uid, content, toPid) => {
			const pid = state.nextPid++;
			state.posts.set(post.pid, { pid, tid, uid, content, toPid, timestamp: post.timestamp });
			return pid;
		},
	};
}

test('selects the newest 40 despite older pinned topics', async () => {
	const { get } = fixture();
	const selected = await collectCategoryTopics(get, { cid: 1 });
	assert.equal(selected.length, 40);
	assert.deepEqual(selected.map(item => item.tid), Array.from({ length: 40 }, (_, i) => 1001 + i));
});

test('collects all pages of replies in order', async () => {
	const get = async (route, query) => {
		assert.equal(route, '/api/topic/1001');
		assert.equal(query.sort, 'oldest_to_newest');
		const posts = query.page === 1 ?
			[{ pid: 10010, tid: 1001, uid: 1, timestamp: 100, user: { username: 'existing' } }] :
			[{ pid: 10011, tid: 1001, uid: 2, timestamp: 200, user: { username: 'new' } }];
		return { tid: 1001, cid: 1, titleRaw: 'Title', timestamp: 90, mainPid: 10010, postcount: 2, posts, pagination: { pageCount: 2 } };
	};
	const topic = await collectTopic(get, { cid: 1 }, 1001, value => value);
	assert.deepEqual(topic.posts.map(post => post.pid), [10010, 10011]);
});

test('imports topics round-robin, including replies, and is repeatable', async () => {
	const { categories, get, rawReads } = fixture();
	const local = fakeLocal();
	const before = structuredClone(local.state);
	const preview = await syncTopics(get, categories, local, false, value => value, () => {});
	assert.deepEqual(local.state, before);
	assert.equal(preview.topics, 82);
	assert.equal(preview.posts, 164);
	assert.deepEqual([...preview.users], ['new']);
	assert.equal(rawReads.length, 0);

	await syncTopics(get, categories, local, true, value => value, () => {});
	assert.deepEqual(local.state.order.slice(0, 7), [1001, 2001, 3001, 1002, 2002, 3002, 1003]);
	assert.equal(local.state.topics.size, 82);
	assert.equal(local.state.posts.size, 164);
	assert.equal(local.state.posts.get(10011).toPid, local.state.posts.get(10010).pid);
	assert.equal(local.state.posts.get(10011).uid, 20);
	assert.equal(local.state.posts.get(10010).content, 'raw 10010');
	assert.equal(local.state.posts.get(10010).timestamp, 100);
	assert.equal(local.state.topics.get(1001).timestamp, 90);
	const repeat = await syncTopics(get, categories, local, true, value => value, () => {});
	assert.equal(repeat.posts, 0);
	assert.equal(local.state.topics.size, 82);
	assert.equal(local.state.posts.size, 164);
	assert.equal(rawReads.length, 164);
});

test('refuses incomplete source posts and skips deleted replies', async () => {
	const { get } = fixture();
	const incomplete = async (route, query) => {
		const data = await get(route, query);
		if (route.startsWith('/api/topic/')) {
			data.posts.pop();
		}
		return data;
	};
	await assert.rejects(collectTopic(incomplete, { cid: 1 }, 1001, value => value), /Incomplete post list/);
	const deleted = async (route, query) => {
		const data = await get(route, query);
		if (route.startsWith('/api/topic/')) {
			data.posts[1].deleted = 1;
		}
		return data;
	};
	const topic = await collectTopic(deleted, { cid: 1 }, 1001, value => value);
	assert.equal(topic.posts.length, 1);
	assert.ok(topic.deletedPids.has(10011));
});

test('refuses a category without a valid local mapping before importing', async () => {
	const { categories, get } = fixture();
	const local = fakeLocal();
	local.categoryMap = async () => ({ 1: 11 });
	await assert.rejects(syncTopics(get, categories, local, true, value => value, () => {}), /no valid local mapping/);
	assert.equal(local.state.topics.size, 0);
});

test('imports posts from deleted accounts anonymously without recreating them', async () => {
	const { get } = fixture();
	const former = async (route, query) => {
		const data = await get(route, query);
		if (route.startsWith('/api/topic/')) {
			data.posts[1].user.username = '[[global:former-user]]';
		}
		return data;
	};
	const local = fakeLocal();
	const report = await syncTopics(former, [{ cid: 3 }], local, true, value => value, () => {});
	assert.equal(local.state.posts.get(30011).uid, 0);
	assert.deepEqual([...report.formerUsers], [2]);
	assert.equal(local.state.users.size, 1);
});

test('skips deleted replies without dropping subsequent replies to them', async () => {
	const { get } = fixture();
	const withDeleted = async (route, query) => {
		const data = await get(route, query);
		if (route.startsWith('/api/topic/')) {
			const tid = data.tid;
			data.posts[1].deleted = 1;
			data.posts.push({ pid: tid * 10 + 2, tid, uid: 1, timestamp: 300, toPid: tid * 10 + 1, user: { username: 'existing' } });
			data.postcount += 1;
		}
		return data;
	};
	const local = fakeLocal();
	const report = await syncTopics(withDeleted, [{ cid: 3 }], local, true, value => value, () => {});
	assert.equal(report.deletedPosts, 2);
	assert.equal(report.detachedReplies, 2);
	assert.equal(local.state.posts.has(30011), false);
	assert.equal(local.state.posts.get(30012).toPid, undefined);
});

test('resumes after a failure without duplicating already imported posts', async () => {
	const { get } = fixture();
	const local = fakeLocal();
	const createPost = local.createPost;
	let fail = true;
	local.createPost = async (...args) => {
		if (args[0].pid === 30011 && fail) {
			fail = false;
			throw new Error('injected failure');
		}
		return createPost(...args);
	};
	await assert.rejects(syncTopics(get, [{ cid: 3 }], local, true, value => value, () => {}), /injected failure/);
	await syncTopics(get, [{ cid: 3 }], local, true, value => value, () => {});
	assert.equal(local.state.topics.size, 2);
	assert.equal(local.state.posts.size, 4);
});

test('rejects missing authors with colliding local slugs', async () => {
	const { get } = fixture();
	const local = fakeLocal();
	local.uidByUsername = async () => 0;
	local.validateUser = async () => 'same-slug';
	await assert.rejects(syncTopics(get, [{ cid: 3 }], local, false, value => value, () => {}), /same local slug/);
	assert.equal(local.state.topics.size, 0);
});
