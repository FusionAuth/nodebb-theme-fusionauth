#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourceClient, collectCategories, localAdapter, restartLocalNodebb } = require('./sync-forum');

const LIMIT = 40;
const TOPIC_PREFIX = 'fusionauth-sync:topic:';
const POST_PREFIX = 'fusionauth-sync:post:';

function positiveId(value, label) {
	const id = Number(value);
	if (!Number.isSafeInteger(id) || id <= 0) {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	return id;
}

function pageCount(data, label) {
	const count = Number(data.pagination?.pageCount);
	if (!Number.isInteger(count) || count < 0 || count > 10000) {
		throw new Error(`Invalid pagination for ${label}.`);
	}
	return Math.max(count, 1);
}

async function collectCategoryTopics(get, category) {
	const found = [];
	const seen = new Set();
	let nonPinned = 0;
	let previousTimestamp = Infinity;
	let pages = 1;
	for (let page = 1; page <= pages && nonPinned < LIMIT; page += 1) {
		const data = await get(`/api/category/${category.cid}`, { sort: 'recently_created', page });
		pages = pageCount(data, `category ${category.cid}`);
		if (Number(data.cid) !== category.cid || !Array.isArray(data.topics)) {
			throw new Error(`Invalid topic list for category ${category.cid}.`);
		}
		for (const topic of data.topics) {
			const tid = positiveId(topic.tid, 'topic ID');
			const timestamp = positiveId(topic.timestamp, 'topic timestamp');
			if (seen.has(tid) || Number(topic.cid) !== category.cid) {
				throw new Error(`Duplicate or misplaced topic ${tid} in category ${category.cid}.`);
			}
			seen.add(tid);
			if (!Number(topic.pinned)) {
				if (timestamp > previousTimestamp) {
					throw new Error(`Category ${category.cid} was not sorted by creation time.`);
				}
				previousTimestamp = timestamp;
				if (!Number(topic.deleted)) {
					nonPinned += 1;
				}
			}
			if (!Number(topic.deleted)) {
				found.push({ tid, timestamp });
			}
		}
	}
	return found.sort((a, b) => b.timestamp - a.timestamp || b.tid - a.tid).slice(0, LIMIT);
}

async function collectTopic(get, category, tid, decode) {
	const posts = [];
	const seen = new Set();
	let topic;
	let pages = 1;
	for (let page = 1; page <= pages; page += 1) {
		const data = await get(`/api/topic/${tid}`, { sort: 'oldest_to_newest', page });
		pages = pageCount(data, `topic ${tid}`);
		if (Number(data.tid) !== tid || Number(data.cid) !== category.cid ||
			!Array.isArray(data.posts) || !Number.isSafeInteger(Number(data.postcount))) {
			throw new Error(`Invalid topic ${tid}.`);
		}
		if (!topic) {
			if (Number(data.deleted) || typeof data.titleRaw !== 'string') {
				throw new Error(`Topic ${tid} is deleted or missing its title.`);
			}
			topic = {
				tid, cid: category.cid, title: decode(data.titleRaw),
				timestamp: positiveId(data.timestamp, 'topic timestamp'),
				mainPid: positiveId(data.mainPid, 'main post ID'),
				postcount: Number(data.postcount), posts, deletedPids: new Set(),
			};
		} else if (Number(data.mainPid) !== topic.mainPid || Number(data.postcount) !== topic.postcount) {
			throw new Error(`Topic ${tid} changed while its posts were being read.`);
		}
		for (const post of data.posts) {
			const pid = positiveId(post.pid, 'post ID');
			if (seen.has(pid) || Number(post.tid) !== tid) {
				throw new Error(`Invalid or duplicate post ${pid} in topic ${tid}.`);
			}
			seen.add(pid);
			if (Number(post.deleted)) {
				if (pid === topic.mainPid) {
					throw new Error(`Topic ${tid} has a deleted main post; refusing to import it.`);
				}
				topic.deletedPids.add(pid);
				continue;
			}
			const uid = Number(post.uid);
			if (!Number.isSafeInteger(uid) || uid < 0) {
				throw new Error(`Invalid author for post ${pid} in topic ${tid}.`);
			}
			const username = uid ? post.user?.username : null;
			if (uid && (typeof username !== 'string' || !username)) {
				throw new Error(`Post ${pid} has no identifiable author.`);
			}
			const formerUser = username === '[[global:former-user]]';
			posts.push({
				pid, uid, username: username ? decode(username) : null,
				timestamp: positiveId(post.timestamp, 'post timestamp'),
				isMain: pid === topic.mainPid,
				toPid: post.toPid ? positiveId(post.toPid, 'reply target') : null,
				formerUser,
				handle: formerUser ? 'Former user' : uid === 0 && typeof post.handle === 'string' ? decode(post.handle) : undefined,
			});
		}
	}
	if (seen.size !== topic.postcount || !posts.length || posts[0].pid !== topic.mainPid) {
		throw new Error(`Incomplete post list for topic ${tid}: expected ${topic.postcount}, received ${seen.size}.`);
	}
	for (let index = 1; index < posts.length; index += 1) {
		if (posts[index].timestamp < posts[index - 1].timestamp) {
			throw new Error(`Posts in topic ${tid} are not ordered oldest first.`);
		}
	}
	return topic;
}

async function syncTopics(get, categories, local, apply, decode, log = console.log) {
	const mappings = await local.categoryMap();
	const localCategories = new Set((await local.listCategories()).map(category => String(category.cid)));
	const queues = [];
	for (const category of categories) {
		const topics = await collectCategoryTopics(get, category);
		if (!topics.length) {
			continue;
		}
		const localCid = mappings[String(category.cid)];
		if (!localCid || !localCategories.has(String(localCid))) {
			throw new Error(`Category ${category.cid} has no valid local mapping; run the forum sync first.`);
		}
		queues.push({ category, localCid: positiveId(localCid, 'local category ID'), topics });
	}
	const sourceAuthors = new Map();
	const sourceUsernames = new Map();
	const localAuthors = new Map();
	const plannedSlugs = new Map();
	const report = { topics: 0, posts: 0, users: new Set(), formerUsers: new Set(), deletedPosts: 0, detachedReplies: 0 };
	for (let round = 0; round < LIMIT; round += 1) {
		for (const queue of queues) {
			const selected = queue.topics[round];
			if (!selected) {
				continue;
			}
			const topic = await collectTopic(get, queue.category, selected.tid, decode);
			report.deletedPosts += topic.deletedPids.size;
			const savedTopic = await local.topicState(topic.tid, queue.localCid);
			log(`${savedTopic ? 'Check' : apply ? 'Import' : 'Would import'} topic ${topic.tid} in category ${topic.cid}: ${topic.title}`);
			let localTid = savedTopic || null;
			for (const post of topic.posts) {
				let uid = 0;
				if (post.formerUser) {
					report.formerUsers.add(post.uid);
				} else if (post.uid) {
					if (sourceAuthors.has(post.uid) && sourceAuthors.get(post.uid) !== post.username) {
						throw new Error(`Production user ${post.uid} has conflicting usernames.`);
					}
					if (sourceUsernames.has(post.username) && sourceUsernames.get(post.username) !== post.uid) {
						throw new Error(`Production username ${JSON.stringify(post.username)} belongs to multiple users.`);
					}
					sourceAuthors.set(post.uid, post.username);
					sourceUsernames.set(post.username, post.uid);
					if (!localAuthors.has(post.username)) {
						let existing = await local.uidByUsername(post.username);
						if (!existing) {
							const slug = await local.validateUser(post.username);
							if (plannedSlugs.has(slug) && plannedSlugs.get(slug) !== post.username) {
								throw new Error(`Missing authors ${JSON.stringify(plannedSlugs.get(slug))} and ${JSON.stringify(post.username)} have the same local slug.`);
							}
							plannedSlugs.set(slug, post.username);
							report.users.add(post.username);
							log(`${apply ? 'Create' : 'Would create'} local author: ${JSON.stringify(post.username)}`);
							existing = apply ? await local.createUser(post.username) : -report.users.size;
						}
						localAuthors.set(post.username, existing);
					}
					uid = localAuthors.get(post.username);
				}
				const savedPost = await local.postState(post.pid, localTid);
				if (savedPost) {
					continue;
				}
				const missingParent = post.toPid && topic.deletedPids.has(post.toPid);
				if (missingParent) {
					report.detachedReplies += 1;
				}
				if (apply) {
					const raw = await get(`/api/post/${post.pid}/raw`);
					if (Number(raw.pid) !== post.pid || typeof raw.content !== 'string') {
						throw new Error(`Invalid raw content for post ${post.pid}.`);
					}
					if (!localTid) {
						localTid = await local.createTopic(topic, queue.localCid, uid, topic.timestamp);
					}
					let toPid;
					if (post.toPid && !missingParent) {
						toPid = await local.postState(post.toPid, localTid);
						if (!toPid) {
							throw new Error(`Reply target ${post.toPid} is missing for post ${post.pid}.`);
						}
					}
					await local.createPost(post, localTid, uid, raw.content, toPid);
				}
				report.posts += 1;
			}
			report.topics += 1;
		}
	}
	return report;
}

function topicAdapter(local) {
	const db = require('/usr/src/app/src/database');
	const topics = require('/usr/src/app/src/topics');
	const posts = require('/usr/src/app/src/posts');
	async function readState(prefix, sourceId, expectedField, expectedValue) {
		const state = await db.getObject(`${prefix}${sourceId}`);
		if (!state) {
			return null;
		}
		if (state.status !== 'complete') {
			throw new Error(`Incomplete prior import for ${prefix}${sourceId}; inspect and restore the local backup before retrying.`);
		}
		const id = positiveId(state.localId, 'saved local ID');
		const object = await db.getObjectFields(`${prefix === TOPIC_PREFIX ? 'topic' : 'post'}:${id}`, [expectedField]);
		if (!object || String(object[expectedField]) !== String(expectedValue)) {
			throw new Error(`Saved mapping for ${prefix}${sourceId} no longer matches the local forum.`);
		}
		return id;
	}
	return {
		...local,
		topicState: (tid, cid) => readState(TOPIC_PREFIX, tid, 'cid', cid),
		postState: (pid, tid) => readState(POST_PREFIX, pid, 'tid', tid),
		createTopic: async (topic, cid, uid, timestamp) => {
			const tid = await db.incrObjectField('global', 'nextTid');
			const key = `${TOPIC_PREFIX}${topic.tid}`;
			await db.setObject(key, { localId: tid, status: 'pending' });
			await topics.create({ tid, cid, uid, title: topic.title, timestamp, tags: [] });
			await db.setObjectField(key, 'status', 'complete');
			return tid;
		},
		createPost: async (post, tid, uid, content, toPid) => {
			const pid = await db.incrObjectField('global', 'nextPid');
			const key = `${POST_PREFIX}${post.pid}`;
			await db.setObject(key, { localId: pid, status: 'pending' });
			await posts.create({ pid, tid, uid, content, timestamp: post.timestamp, isMain: post.isMain, toPid, handle: post.handle });
			await db.setObjectField(key, 'status', 'complete');
			return pid;
		},
	};
}

async function inside(apply) {
	const get = await sourceClient(process.env.NODEBB_SOURCE_API_KEY);
	const password = process.env.NODEBB_IMPORT_PASSWORD;
	delete process.env.NODEBB_IMPORT_PASSWORD;
	if (apply && !password) {
		throw new Error('Set NODEBB_IMPORT_PASSWORD for missing local authors.');
	}
	const { decodeHTML } = require('/usr/src/app/node_modules/entities');
	const categories = await collectCategories(get, decodeHTML);
	delete process.env.NODEBB_SOURCE_API_KEY;
	const local = await localAdapter(password);
	try {
		const report = await syncTopics(get, categories, topicAdapter(local), apply, decodeHTML);
		console.log(`${apply ? 'Applied' : 'Dry run'}: ${report.topics} topics checked, ${report.posts} new posts, ${report.users.size} missing authors.`);
		if (report.formerUsers.size) {
			console.warn(`Warning: posts from ${report.formerUsers.size} deleted production accounts are imported anonymously.`);
		}
		if (report.deletedPosts) {
			console.warn(`Warning: ${report.deletedPosts} deleted replies ${apply ? 'were' : 'would be'} skipped; ` +
				`${report.detachedReplies} replies to them ${apply ? 'were' : 'would be'} imported without a parent link.`);
		}
	} finally {
		await local.close();
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some(arg => !['--apply', '--inside-container'].includes(arg))) {
		throw new Error('Usage: node test/sync-scripts/sync-topics.js [--apply]');
	}
	const apply = args.includes('--apply');
	if (args.includes('--inside-container')) {
		await inside(apply);
		return;
	}
	if (!process.env.NODEBB_SOURCE_API_KEY || (apply && !process.env.NODEBB_IMPORT_PASSWORD)) {
		throw new Error('Set NODEBB_SOURCE_API_KEY and, for --apply, NODEBB_IMPORT_PASSWORD.');
	}
	const command = ['compose', '-f', 'test/compose.yaml', 'exec', '-T', '-e', 'NODEBB_SOURCE_API_KEY',
		...(apply ? ['-e', 'NODEBB_IMPORT_PASSWORD'] : []),
		'nodebb', 'node', '/theme/test/sync-scripts/sync-topics.js', '--inside-container',
		...(apply ? ['--apply'] : [])];
	const result = spawnSync('docker', command, {
		cwd: path.resolve(__dirname, '../..'), stdio: 'inherit',
	});
	if (result.error || result.status !== 0) {
		throw result.error || new Error(`Topic sync failed (status ${result.status}); local changes may be partial.`);
	}
	if (apply) {
		await restartLocalNodebb(path.resolve(__dirname, '../..'));
	}
}

module.exports = { collectCategoryTopics, collectTopic, syncTopics, topicAdapter };

if (require.main === module) {
	main().then(() => {
		if (process.argv.includes('--inside-container')) {
			process.exit(0);
		}
	}).catch(error => {
		console.error(`Topic sync failed: ${error.message}`);
		if (process.argv.includes('--inside-container')) {
			process.exit(1);
		}
		process.exitCode = 1;
	});
}
