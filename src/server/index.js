import '@soundworks/helpers/polyfills.js';
import { Server } from '@soundworks/core/server.js';
// import { configureMaxClient } from '@soundworks/max'; // to be tested
import { loadConfig, configureHttpRouter } from '@soundworks/helpers/server.js';

import fs from 'fs';
import { Worker } from 'worker_threads';

import ServerPluginPlatformInit from '@soundworks/plugin-platform-init/server.js';
import ServerPluginFilesystem from '@soundworks/plugin-filesystem/server.js';
import ServerPluginMixing from '@soundworks/plugin-mixing/server.js';

import globalSchema from './schemas/global.js';
import controllerSchema from './schemas/controller.js';
import groupSchema from './schemas/group.js';
import sourceSchema from './schemas/source.js';
import satelliteSchema from './schemas/satellite.js';

import { AudioBufferLoader } from '@ircam/sc-loader';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

const config = loadConfig(process.env.ENV, import.meta.url);
// configureMaxClient(config);

console.log(`
--------------------------------------------------------
- launching "${config.app.name}" in "${process.env.ENV || 'default'}" environment
- [pid: ${process.pid}]
--------------------------------------------------------
`);

/**
 * Create the soundworks server
 */
const server = new Server(config);
configureHttpRouter(server);

/**
 * Register plugins and schemas
 */
// server.pluginManager.register('my-plugin', plugin);
// server.stateManager.registerSchema('my-schema', definition);
const pathSoundbank = 'public/soundbank';
const pathCalibration = 'public/calibration';
const pathAnalysis = 'public/analysis-data';
const pathPresets = 'public/presets';

server.pluginManager.register('platform-init', ServerPluginPlatformInit);
server.pluginManager.register('filesystem-soundbank', ServerPluginFilesystem, {
  dirname: pathSoundbank,
  publicPath: 'soundbank'
});
server.pluginManager.register('filesystem-calibration', ServerPluginFilesystem, {
  dirname: pathCalibration,
});
server.pluginManager.register('filesystem-analysis', ServerPluginFilesystem, {
  dirname: pathAnalysis,
  publicPath: 'analysis-data'
});
server.pluginManager.register('filesystem-presets', ServerPluginFilesystem, {
  dirname: pathPresets,
  publicPath: 'presets'
});
server.pluginManager.register('mixing', ServerPluginMixing);

server.stateManager.defineClass('global', globalSchema);
server.stateManager.defineClass('controller', controllerSchema);
server.stateManager.defineClass('group', groupSchema);
server.stateManager.defineClass('source', sourceSchema);
server.stateManager.defineClass('satellite', satelliteSchema);

/**
 * Launch application (init plugins, http server, etc.)
 */
await server.start();

const audioBufferLoader = new AudioBufferLoader(48000);

const filesystemSoundbank = await server.pluginManager.get('filesystem-soundbank');
const filesystemAnalysis = await server.pluginManager.get('filesystem-analysis');
const filesystemPresets = await server.pluginManager.get('filesystem-presets');

// soundfiles analysis
const worker = new Worker('./src/server/mfcc.worker.js');
worker.on('message', e => {
  if (e.type === 'analyze-soundfile') {
    console.log('analysis done');
    // save analysis data to file
    const bufferName = e.data.filename.split('.')[0];
    const filename = `data_analysis_${bufferName}.json`;
    filesystemAnalysis.writeFile(filename, JSON.stringify(e.data));
  }
});
worker.on("error", (msg) => {
  console.log(msg);
});

filesystemSoundbank.getTree().children.forEach(async e => {
  const name = e.name.split('.')[0];
  const analysisFilename = `data_analysis_${name}.json`;
  const file = filesystemAnalysis.getTree().children.find(e => e.name === analysisFilename);
  if (!file) {
    const buffer = await audioBufferLoader.load(e.path);
    console.log(buffer);
    worker.postMessage({
      type: 'analyze-soundfile',
      data: {
        filename: e.name,
        sampleRate: buffer.sampleRate,
        arrayData: buffer.getChannelData(0),
      },
    });
  }
});

filesystemSoundbank.onUpdate(async updates => {
  for (const event of updates.events) {
    if (event.type === 'create') {
      // compute kdtree of soundfile upon upload
      const buffer = await audioBufferLoader.load(event.node.path);
      worker.postMessage({
        type: 'analyze-soundfile',
        data: {
          filename: event.node.name,
          sampleRate: buffer.sampleRate,
          arrayData: buffer.getChannelData(0),
        },
      });
    }
  }
});


// let script = fs.readFileSync(path.join(process.cwd(), 'src', 'clients', 'utils', 'mfcc.worker.js'));
// script = script.toString().replace(/\n/g, '');

// this.worker = new Worker(`data:application/javascript,${script}`);
// const mfccWorker = new Worker('./src/server/utils/mfcc.worker.js');

const global = await server.stateManager.create('global');
const groups = new Map();
const groupsSources = new Map();
const satellites = await server.stateManager.getCollection('satellite');
const controllers = await server.stateManager.getCollection('controller');

function saveGroups() {
  const groupsList = [];
  groups.forEach(group => {
    groupsList.push({
      name: group.get('name'),
      color: group.get('color'),
    });
  });
  filesystemPresets.writeFile('groups.json', JSON.stringify(groupsList, null, 2));
}

function saveSatellitesGroupsMap() {
  const map = JSON.parse(fs.readFileSync(filesystemPresets.getTree().children.find(e => e.name === "groups-satellites-map.json").path));
  satellites.forEach(satellite => {
    const group = groups.get(satellite.get('group'));
    if (group) {
      map[satellite.get('name')] = group.get('name');
    }

  });
  filesystemPresets.writeFile('groups-satellites-map.json', JSON.stringify(map, null, 2));
}

// load existing group config and presets
const groupsList = JSON.parse(fs.readFileSync(filesystemPresets.getTree().children.find(e => e.name === "groups.json").path));
const presets = JSON.parse(fs.readFileSync(filesystemPresets.getTree().children.find(e => e.name === "presets.json").path));

global.set({presets});

groupsList.forEach(async value => {
  const group = await server.stateManager.create('group', value);
  const groupSource = await server.stateManager.create('source');
  group.set({sourceState: groupSource.id});
  group.onUpdate(updates => {
    if ('sourceName' in updates && updates.sourceName !== null) {
      const sourceNameSplit = updates.sourceName.split('.')[0];
      const analysisFilename = `data_analysis_${sourceNameSplit}.json`
      const pathData = filesystemAnalysis.getTree().children.find(e => e.name === analysisFilename).path;
      const analysisData = fs.readFileSync(pathData, 'utf8');
      groupSource.set({
        sourceData: {
          name: updates.sourceName,
          data: analysisData
        }
      });
    }
    if ('color' in updates) {
      saveGroups();
    }
    if ('name' in updates) {
      saveGroups();
    }
  });

  groups.set(group.id, group);
});

global.onUpdate(update => {
  Object.entries(update).forEach(async ([key, value]) => {
    switch (key) {
      case 'presets': {
        filesystemPresets.writeFile('presets.json', JSON.stringify(value));
        break;
      }
      case 'createGroup': {
        const group = await server.stateManager.create('group');
        const groupSource = await server.stateManager.create('source');
        await group.set({
          name: `group-${group.id}`,
          sourceState: groupSource.id,
        });
        group.onUpdate(updates => {
          if ('sourceName' in updates) {
            const sourceNameSplit = updates.sourceName.split('.')[0];
            const analysisFilename = `data_analysis_${sourceNameSplit}.json`
            const pathData = filesystemAnalysis.getTree().children.find(e => e.name === analysisFilename).path;
            const analysisData = fs.readFileSync(pathData, 'utf8');
            groupSource.set({sourceData: {
              name: updates.sourceName,
              data: analysisData
            }});
          }
        });

        groups.set(group.id, group);
        groupsSources.set(group.id, groupSource);
        saveGroups();
        break;
      }
      case 'createSingleGroup': {
        const group = await server.stateManager.create('group');
        const groupSource = await server.stateManager.create('source');
        await group.set({
          name: `group-${group.id}`,
          sourceState: groupSource.id
        });
        group.onUpdate(updates => {
          if ('sourceName' in updates) {
            const sourceNameSplit = updates.sourceName.split('.')[0];
            const analysisFilename = `data_analysis_${sourceNameSplit}.json`
            const pathData = filesystemAnalysis.getTree().children.find(e => e.name === analysisFilename).path;
            const analysisData = fs.readFileSync(pathData, 'utf8');
            groupSource.set({
              sourceData: {
                name: updates.sourceName,
                data: analysisData
              }
            });
          }
        });

        groups.set(group.id, group);
        groupsSources.set(group.id, groupSource);
        satellites.forEach(satellite => {
          satellite.set({group: group.id});
        });
        saveGroups();
        saveSatellitesGroupsMap();
        break;
      }
      case 'createOneGroupPerClient': {
        for (const satellite of satellites) {
          const group = await server.stateManager.create('group', {
            name: satellite.get('name'),
          });
          const groupSource = await server.stateManager.create('source');
          await group.set({ sourceState: groupSource.id });
          group.onUpdate(updates => {
            if ('sourceName' in updates) {
              const sourceNameSplit = updates.sourceName.split('.')[0];
              const analysisFilename = `data_analysis_${sourceNameSplit}.json`
              const pathData = filesystemAnalysis.getTree().children.find(e => e.name === analysisFilename).path;
              const analysisData = fs.readFileSync(pathData, 'utf8');
              groupSource.set({
                sourceData: {
                  name: updates.sourceName,
                  data: analysisData
                }
              });
            }
          });

          await groups.set(group.id, group);
          await groupsSources.set(group.id, groupSource);
          await satellite.set({ group: group.id });
        }
        saveGroups();
        saveSatellitesGroupsMap();
        break;
      }
      case 'saveGroupsSatellitesMap': {
        saveSatellitesGroupsMap();
        break;
      }
      case 'deleteGroup': {
        const group = groups.get(value);
        const groupSource = groupsSources.get(value);
        groups.delete(group.id);
        groupsSources.delete(group.id);
        await group.delete();
        groupSource ? await groupSource.delete(): null;
        saveGroups();
        break;
      }
    }
  });
});


satellites.onAttach(satellite => {
  const groupsSatellitesMap = JSON.parse(fs.readFileSync(filesystemPresets.getTree().children.find(e => e.name === "groups-satellites-map.json").path));
  const satelliteName = satellite.get('name');
  if (satelliteName in groupsSatellitesMap) {
    const groupName = groupsSatellitesMap[satelliteName];
    const groupState = Array.from(groups.values()).find(group => {
      return group.get('name') === groupName;
    });
    if (groupState) {
      // TODO : fix this
      setTimeout(() => satellite.set({group: groupState.id}), 200);
    }
  }
});


controllers.onUpdate((state, updates) => {
  Object.entries(updates).forEach(([key, value]) => {
    switch (key) {
      case 'loadCalibrationFile': {
        const path = `${pathCalibration}/${value}`
        const data = fs.readFileSync(path, 'utf8');

        state.set({calibrationFileRead: {
          filename: value,
          data
        }});
        break;
      }
      case 'loadAnalysisFile': {
        const filenameSplit = value.split('.')[0];
        const analysisFilename = `data_analysis_${filenameSplit}.json`
        const path = `${pathAnalysis}/${analysisFilename}`
        const data = fs.readFileSync(path, 'utf8');
        const {means, std, minRms, maxRms} = JSON.parse(data);
        const norm = {
          means,
          std,
          minRms,
          maxRms,
        };

        state.set({analysisFileRead: {
          filename: value,
          data: norm,
        }});
        break;
      }
    }
  });
});


