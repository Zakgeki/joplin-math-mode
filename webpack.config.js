// -----------------------------------------------------------------------------
// This file is used to build the plugin file (.jpl) and plugin info (.json). It
// is recommended not to edit this file as it would be overwritten when updating
// the plugin framework. If you do make some changes, consider using an external
// JS file and requiring it here to minimize the changes. That way when you
// update, you can easily restore the functionality you've added.
// -----------------------------------------------------------------------------

const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const chalk = require('chalk');
const CopyPlugin = require('copy-webpack-plugin');
const WebpackOnBuildPlugin = require('on-build-webpack');
const tar = require('tar');
const glob = require('glob');
const execSync = require('child_process').execSync;

const rootDir = path.resolve(__dirname);
const userConfigFilename = './plugin.config.json';
const userConfigPath = path.resolve(rootDir, userConfigFilename);
const distDir = path.resolve(rootDir, 'dist');
const srcDir = path.resolve(rootDir, 'src');
const publishDir = path.resolve(rootDir, 'publish');

const userConfig = Object.assign({}, {
	extraScripts: [],
}, fs.pathExistsSync(userConfigPath) ? require(userConfigFilename) : {});

const manifestPath = `${srcDir}/manifest.json`;
const packageJsonPath = `${rootDir}/package.json`;
const manifest = readManifest(manifestPath);
const pluginArchiveFilePath = path.resolve(publishDir, `${manifest.id}.jpl`);
const pluginInfoFilePath = path.resolve(publishDir, `${manifest.id}.json`);

fs.removeSync(distDir);
fs.removeSync(publishDir);
fs.mkdirpSync(publishDir);

function validatePackageJson() {
	const content = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
	if (!content.name || content.name.indexOf('joplin-plugin-') !== 0) {
		console.warn(chalk.yellow(`WARNING: To publish the plugin, the package name should start with "joplin-plugin-" (found "${content.name}") in ${packageJsonPath}`));
	}

	if (!content.keywords || content.keywords.indexOf('joplin-plugin') < 0) {
		console.warn(chalk.yellow(`WARNING: To publish the plugin, the package keywords should include "joplin-plugin" (found "${JSON.stringify(content.keywords)}") in ${packageJsonPath}`));
	}

	if (content.scripts && content.scripts.postinstall) {
		console.warn(chalk.yellow(`WARNING: package.json contains a "postinstall" script. It is recommended to use a "prepare" script instead so that it is executed before publish. In ${packageJsonPath}`));
	}
}

function fileSha256(filePath) {
	const content = fs.readFileSync(filePath);
	return crypto.createHash('sha256').update(content).digest('hex');
}

function currentGitInfo() {
	try {
		let branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' }).toString().trim();
		const commit = execSync('git rev-parse HEAD', { stdio: 'pipe' }).toString().trim();
		if (branch === 'HEAD') branch = 'master';
		return `${branch}:${commit}`;
	} catch (error) {
		const messages = error.message ? error.message.split('\n') : [''];
		console.info(chalk.cyan('Could not get git commit (not a git repo?):', messages[0].trim()));
		console.info(chalk.cyan('Git information will not be stored in plugin info file'));
		return '';
	}
}

function readManifest(manifestPath) {
	const content = fs.readFileSync(manifestPath, 'utf8');
	const output = JSON.parse(content);
	if (!output.id) throw new Error(`Manifest plugin ID is not set in ${manifestPath}`);
	return output;
}

function createPluginArchive(sourceDir, destPath) {
	const distFiles = glob.sync(`${sourceDir}/**/*`, { nodir: true })
		.map(f => f.substr(sourceDir.length + 1));

	if (!distFiles.length) throw new Error('Plugin archive was not created because the "dist" directory is empty');

	fs.removeSync(destPath);

	tar.create(
		{
			strict: true,
			portable: true,
			file: destPath,
			cwd: sourceDir,
			sync: true,
		},
		distFiles
	);

	console.info(chalk.cyan(`Plugin archive has been created in ${destPath}`));
}

function createPluginInfo(manifestPath, destPath, jplFilePath) {
	const contentText = fs.readFileSync(manifestPath, 'utf8');
	const content = JSON.parse(contentText);
	content._publish_hash = `sha256:${fileSha256(jplFilePath)}`;
	content._publish_commit = currentGitInfo();
	fs.writeFileSync(destPath, JSON.stringify(content, null, '\t'), 'utf8');
}

function onBuildCompleted() {
	try {
		createPluginArchive(distDir, pluginArchiveFilePath);
		createPluginInfo(manifestPath, pluginInfoFilePath, pluginArchiveFilePath);
		validatePackageJson();
	} catch (error) {
		console.error(chalk.red(error.message));
	}
}

const baseConfig = {
	mode: 'production',
	target: 'node',
	stats: 'errors-only',
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				use: 'ts-loader',
				exclude: /node_modules/,
			},
		],
	},
};

const pluginConfig = Object.assign({}, baseConfig, {
	entry: './src/index.ts',
	resolve: {
		alias: {
			api: path.resolve(__dirname, 'api'),
		},
		extensions: ['.tsx', '.ts', '.js'],
	},
	output: {
		filename: 'index.js',
		path: distDir,
	},
	plugins: [
		new CopyPlugin({
			patterns: [
				{
					from: '**/*',
					context: path.resolve(__dirname, 'src'),
					to: path.resolve(__dirname, 'dist'),
					globOptions: {
						ignore: [
							// All TypeScript files are compiled to JS and
							// already copied into /dist so we don't copy them.
							'**/*.ts',
							'**/*.tsx',
						],
					},
				},
			],
		}),
	],
});

const extraScriptConfig = Object.assign({}, baseConfig, {
	resolve: {
		alias: {
			api: path.resolve(__dirname, 'api'),
		},
		extensions: ['.tsx', '.ts', '.js'],
	},
});

function resolveExtraScriptPath(name) {
	const relativePath = `./src/${name}`;

	const fullPath = path.resolve(`${rootDir}/${relativePath}`);
	if (!fs.pathExistsSync(fullPath)) throw new Error(`Could not find extra script: "${name}" at "${fullPath}"`);

	const s = name.split('.');
	s.pop();
	const nameNoExt = s.join('.');

	return {
		entry: relativePath,
		output: {
			filename: `${nameNoExt}.js`,
			path: distDir,
			library: 'default',
			libraryTarget: 'commonjs',
			libraryExport: 'default',
		},
	};
}

function addExtraScriptConfigs(baseConfig, userConfig) {
	if (!userConfig.extraScripts.length) return baseConfig;

	const output = [];

	for (const scriptName of userConfig.extraScripts) {
		const scriptPaths = resolveExtraScriptPath(scriptName);
		output.push(Object.assign({}, extraScriptConfig, {
			entry: scriptPaths.entry,
			output: scriptPaths.output,
		}));
	}

	return baseConfig.concat(output);
}

function addLastConfigStep(config) {
	const lastConfig = config[config.length - 1];
	if (!lastConfig.plugins) lastConfig.plugins = [];
	lastConfig.plugins.push(new WebpackOnBuildPlugin(onBuildCompleted));
	config[config.length - 1] = lastConfig;
	return config;
}

let exportedConfigs = [pluginConfig];

try {
	exportedConfigs = addExtraScriptConfigs(exportedConfigs, userConfig);
	exportedConfigs = addLastConfigStep(exportedConfigs);
} catch (error) {
	console.error(chalk.red(error.message));
	process.exit(1);
}

module.exports = exportedConfigs;
