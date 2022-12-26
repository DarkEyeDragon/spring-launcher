'use strict';

const { NextGenDownloader } = require('spring-nextgen-dl');

const { log, wrapEmitterLogs } = require('./spring_log');
const { gui } = require('./launcher_gui');
const springDownloader = require('./spring_downloader');
const { wizard } = require('./launcher_wizard');
const { generateAndBroadcastWizard } = require('./launcher_wizard_util');
const springPlatform = require('./spring_platform');
const path = require('path');
const fs = require('fs');
const { applyDefaults, hotReloadSafe, reloadConfig, config } = require('./launcher_config');
const { app } = require('electron');

springDownloader.on('started', downloadItem => {
	log.info(`Download started: ${downloadItem}`);
	if (wizard.isActive) {
		gui.send('dl-started', downloadItem);
	}
});

springDownloader.on('progress', function (downloadItem, current, total) {
	if (total < 1024 * 1024) {
		return; // ignore downloads less than 1MB (probably not real downloads!)
	}

	const LOG_INTERVAL = 1000;
	const GUI_INTERVAL = 10;

	let shouldLog = true;
	let shouldUpdateGUI = true;

	if (typeof this.prevLogTime == 'undefined') {
		this.prevLogTime = (new Date()).getTime();
	} else {
		const now = (new Date()).getTime();
		if (now - this.prevLogTime < LOG_INTERVAL) {
			shouldLog = false;
		} else {
			this.prevLogTime = now;
		}
		if (now - this.prevGUIUpdateTime < GUI_INTERVAL) {
			shouldUpdateGUI = false;
		} else {
			this.prevGUIUpdateTime = now;
		}
	}

	if (shouldLog) {
		log.info(`Download progress: ${downloadItem}, ${current}, ${total}`);
	}
	if (shouldUpdateGUI && wizard.isActive) {
		const mainWindow = gui.getMainWindow();
		if (mainWindow != null) {
			mainWindow.setProgressBar(current / total);
		}
		gui.send('dl-progress', downloadItem, current, total);
	}
});

springDownloader.on('finished', (downloadItem) => {
	log.info(`Download finished: ${downloadItem}`);
	if (wizard.isActive) {
		wizard.isActive = false;

		gui.send('dl-finished', downloadItem);
		if (wizard.isConfigDownload) {
			wizard.isConfigDownload = false;

			try {
				if (maybeUpdateConfig(downloadItem)) {
					gui.send('dl-finished', 'config');
					log.info('Config files are different - restarting');
					app.relaunch();
					app.exit();
				} else {
					log.info('Config files are same - continue');
					wizard.nextStep();
				}
			} catch (err) {
				log.error('Failed to update config file. Ignoring.');
				log.error(err);
				wizard.nextStep();
			}
		} else {
			wizard.nextStep();
		}
	}
});

function maybeUpdateConfig(downloadItem) {
	const tmpFile = path.join(springPlatform.writePath, downloadItem);
	const configFile = path.join(springPlatform.writePath, 'config.json');
	fs.renameSync(tmpFile, configFile);
	let newConfig = JSON.parse(fs.readFileSync(configFile));
	newConfig = applyDefaults(newConfig);

	switch (hotReloadSafe(newConfig)) {
		case "restart":
			return true;
		case "reload":
			const oldConfigId = config.package.id;
			reloadConfig(newConfig);
			config.setConfig(oldConfigId);
			gui.send('all-configs', config.getAvailableConfigs());
			generateAndBroadcastWizard();
			return false;
		case "same":
			// In case current config is the same but the list of configs changed.
			reloadConfig(newConfig);
			gui.send('all-configs', config.getAvailableConfigs());
			return false;
	}
}

springDownloader.on('failed', (downloadItem, msg) => {
	log.error(`${downloadItem}: ${msg}`);
	if (wizard.isActive) {
		wizard.isActive = false;
		gui.send('error', msg);
		wizard.setEnabled(false);
	}
});

wizard.on('stepsGenerated', async steps => {
	let promises = [];
	for (const step of steps) {
		if (step.name === 'nextgen') {
			const nextGenDownloader = new NextGenDownloader(springPlatform.butlerPath, springPlatform.writePath);
			wrapEmitterLogs(nextGenDownloader);
			promises.push(nextGenDownloader.downloadMetadata(step.item));
		}
	}

	try {
		return await Promise.all(promises);
	} catch (err) {
		log.warn(`Couldn't fetch early metadata: ${err}`);
	}
});
