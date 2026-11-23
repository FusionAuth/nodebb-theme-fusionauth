#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const source = 'https://fusionauth.io/community/forum';
const themeId = 'nodebb-theme-fusionauth';
const maxBytes = 5 * 1024 * 1024;
const personaFields = ['hideSubCategories', 'hideCategoryLastPost', 'enableQuickReply'];

function appearanceFromConfig(config) {
	if (!config || config['theme:id'] !== themeId) {
		throw new Error(`The source must use ${themeId}.`);
	}
	for (const key of ['siteTitle', 'browserTitle', 'titleLayout', 'defaultBootswatchSkin']) {
		if (typeof config[key] !== 'string') {
			throw new Error(`Source config is missing the string ${key}.`);
		}
	}
	for (const key of ['showSiteTitle', 'disableCustomUserSkins', ...personaFields]) {
		if (typeof config[key] !== 'boolean') {
			throw new Error(`Source config is missing the boolean ${key}.`);
		}
	}
	return {
		config: {
			title: config.siteTitle,
			browserTitle: config.browserTitle,
			titleLayout: config.titleLayout.replace(/&#123;/g, '{').replace(/&#125;/g, '}'),
			bootswatchSkin: config.defaultBootswatchSkin,
			showSiteTitle: Number(config.showSiteTitle),
			disableCustomUserSkins: Number(config.disableCustomUserSkins),
		},
		persona: Object.fromEntries(personaFields.map(key => [key, config[key] ? 'on' : 'off'])),
	};
}

function appearanceFromHtml(html, cheerio) {
	const $ = cheerio.load(html);
	const styles = $('head style');
	if (styles.length > 1) {
		throw new Error('Cannot identify the custom CSS: the source has multiple head style elements.');
	}
	const css = styles.length ? styles.first().html() : '';
	if (/@(?:import|use|forward)\b|url\s*\(/i.test(css)) {
		throw new Error('Custom CSS contains imports or URLs; review it manually before applying.');
	}
	const logos = $('img.forum-logo');
	if (logos.length !== 1) {
		throw new Error('Expected exactly one forum logo in the source page.');
	}
	const src = logos.attr('src');
	if (!src) {
		throw new Error('The source forum logo has no URL.');
	}
	const logo = new URL(src, `${source}/`);
	if (logo.origin !== new URL(source).origin ||
		!logo.pathname.startsWith('/community/forum/assets/uploads/system/')) {
		throw new Error('The source logo is not a forum system upload.');
	}
	return { css, logoUrl: logo.href, logoAlt: logos.attr('alt') || '' };
}

async function getBytes(url, headers = {}) {
	const response = await fetch(url, {
		headers,
		redirect: 'error',
		signal: AbortSignal.timeout(20000),
	});
	if (!response.ok) {
		throw new Error(`Source request failed: HTTP ${response.status} for ${new URL(url).pathname}`);
	}
	const chunks = [];
	let length = 0;
	for await (const chunk of response.body) {
		length += chunk.length;
		if (length > maxBytes) {
			throw new Error(`Source response exceeds ${maxBytes} bytes.`);
		}
		chunks.push(chunk);
	}
	return { bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') || '' };
}

async function applyInsideContainer() {
	const apiKey = process.env.NODEBB_SOURCE_API_KEY;
	if (!apiKey) {
		throw new Error('Set NODEBB_SOURCE_API_KEY to the source forum API key.');
	}
	const cheerio = require('/usr/src/app/node_modules/cheerio');
	const [configResponse, pageResponse] = await Promise.all([
		getBytes(`${source}/api/admin/config`, { Authorization: `Bearer ${apiKey}` }),
		getBytes(`${source}/`),
	]);
	const settings = appearanceFromConfig(JSON.parse(configResponse.bytes.toString('utf8')));
	const page = appearanceFromHtml(pageResponse.bytes.toString('utf8'), cheerio);
	const logoResponse = await getBytes(page.logoUrl);
	const mime = logoResponse.contentType.split(';')[0].trim().toLowerCase();
	const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
	if (!extensions[mime]) {
		throw new Error(`Unsupported source logo content type: ${mime || '(missing)'}.`);
	}

	const nconf = require('/usr/src/app/node_modules/nconf');
	nconf.env({ separator: '__' });
	const prestart = require('/usr/src/app/src/prestart');
	prestart.setupWinston();
	prestart.loadConfig('/opt/config/config.json');
	const db = require('/usr/src/app/src/database');
	const meta = require('/usr/src/app/src/meta');
	const fs = require('node:fs/promises');
	await db.init();
	try {
		if (await db.getObjectField('config', 'theme:id') !== themeId) {
			throw new Error(`The local forum must have ${themeId} active.`);
		}
		if (settings.config.bootswatchSkin &&
			!await meta.css.isSkinValid(settings.config.bootswatchSkin)) {
			throw new Error(`The source skin is not installed locally: ${settings.config.bootswatchSkin}`);
		}
		const logoName = `fusionauth-synced-logo.${extensions[mime]}`;
		const logoPath = path.join(nconf.get('upload_path'), 'system', logoName);
		await fs.mkdir(path.dirname(logoPath), { recursive: true });
		await fs.writeFile(logoPath, logoResponse.bytes);
		await meta.configs.setMultiple({
			...settings.config,
			customCSS: page.css,
			useCustomCSS: page.css ? 1 : 0,
		});
		await db.setObject('config', {
			'brand:logo': `/assets/uploads/system/${logoName}`,
			'brand:logo:alt': page.logoAlt,
			'brand:logo:updatedAt': Date.now(),
		});
		await meta.settings.set('persona', settings.persona);
		console.log('Imported appearance settings, published CSS, and logo.');
	} finally {
		await db.close();
	}
}

async function main() {
	if (process.argv.includes('--inside-container')) {
		await applyInsideContainer();
		return;
	}
	if (!process.env.NODEBB_SOURCE_API_KEY) {
		throw new Error('Set NODEBB_SOURCE_API_KEY to the source forum API key.');
	}
	const options = { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' };
	for (const args of [
		['compose', 'exec', '-T', '-e', 'NODEBB_SOURCE_API_KEY', 'nodebb', 'node', '/theme/test/sync-scripts/sync-appearance.js', '--inside-container'],
		['compose', 'restart', 'nodebb'],
	]) {
		const result = spawnSync('docker', args, options);
		if (result.error) {
			throw result.error;
		}
		if (result.status !== 0) {
			throw new Error(`docker compose ${args[1]} failed with status ${result.status}.`);
		}
	}
	const deadline = Date.now() + 120000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch('http://127.0.0.1:4567/api/config', {
				signal: AbortSignal.timeout(3000),
			});
			if (response.ok && (await response.json())['theme:id'] === themeId) {
				console.log('Local NodeBB is ready with the FusionAuth theme.');
				return;
			}
		} catch (error) {
			if (!['TypeError', 'TimeoutError'].includes(error.name)) {
				throw error;
			}
		}
		await new Promise(resolve => setTimeout(resolve, 2000));
	}
	throw new Error('Local NodeBB did not become ready after the restart.');
}

module.exports = { appearanceFromConfig, appearanceFromHtml };

if (require.main === module) {
	main().then(() => {
		if (process.argv.includes('--inside-container')) {
			process.exit(0);
		}
	}).catch(error => {
		console.error(`Appearance sync failed: ${error.message}`);
		if (process.argv.includes('--inside-container')) {
			process.exit(1);
		}
		process.exitCode = 1;
	});
}
