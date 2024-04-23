import '@soundworks/helpers/polyfills.js';
import { Server } from '@soundworks/core/server.js';
// import { configureMaxClient } from '@soundworks/max';
import { loadConfig } from '../utils/load-config.js';
import '../utils/catch-unhandled-errors.js';

import fs from 'fs';
import { Worker } from 'worker_threads';

import pluginPlatformInit from '@soundworks/plugin-platform-init/server.js';
import pluginFilesystem from '@soundworks/plugin-filesystem/server.js';

import globalSchema from './schemas/global.js';
import controllerSchema from './schemas/controller.js';
import groupSchema from './schemas/group.js';
import satelliteSchema from './schemas/satellite.js';

import { AudioBufferLoader } from '@ircam/sc-loader';
import satellite from './schemas/satellite.js';
import { group } from 'console';



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
// configure the server for usage within this application template
server.useDefaultApplicationTemplate();

/**
 * Register plugins and schemas
 */
// server.pluginManager.register('my-plugin', plugin);
// server.stateManager.registerSchema('my-schema', definition);
const pathSoundbank = 'public/soundbank';
const pathCalibration = 'public/calibration';
const pathAnalysis = 'public/analysis-data';
const pathPresets = 'public/presets';

server.pluginManager.register('platform-init', pluginPlatformInit);
server.pluginManager.register('filesystem-soundbank', pluginFilesystem, {
  dirname: pathSoundbank,
  publicPath: 'soundbank'
});
server.pluginManager.register('filesystem-calibration', pluginFilesystem, {
  dirname: pathCalibration,
});
server.pluginManager.register('filesystem-analysis', pluginFilesystem, {
  dirname: pathAnalysis,
  publicPath: 'analysis-data'
});
server.pluginManager.register('filesystem-presets', pluginFilesystem, {
  dirname: pathPresets,
  publicPath: 'presets'
});

server.stateManager.registerSchema('global', globalSchema);
server.stateManager.registerSchema('controller', controllerSchema);
server.stateManager.registerSchema('group', groupSchema);
server.stateManager.registerSchema('satellite', satelliteSchema);

/**
 * Launch application (init plugins, http server, etc.)
 */
await server.start();

const audioBufferLoader = new AudioBufferLoader({});

const filesystemSoundbank = await server.pluginManager.get('filesystem-soundbank');
const filesystemAnalysis = await server.pluginManager.get('filesystem-analysis');
const filesystemPresets = await server.pluginManager.get('filesystem-presets');

// soundfiles analysis 
const worker = new Worker('./src/server/utils/mfcc.worker.js');
worker.on('message', e => {
  if (e.type === 'analyse-soundfile') {
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
  filesystemPresets.writeFile('groups.json', JSON.stringify(groupsList));
}

function saveSatellitesGroupsMap() {
  const map = {}
  satellites.forEach(satellite => {
    const group = groups.get(satellite.get('group'));
    if (group) {
      map[satellite.get('name')] = group.get('name');
    }
  }); 
  filesystemPresets.writeFile('groups-satellites-map.json', JSON.stringify(map));
}

// load existing group config and presets
const groupsList = JSON.parse(fs.readFileSync(filesystemPresets.getTree().children.find(e => e.name === "groups.json").path));
const presets = JSON.parse(fs.readFileSync(filesystemPresets.getTree().children.find(e => e.name === "presets.json").path));

global.set({presets});

groupsList.forEach(async value => {
  const group = await server.stateManager.create('group', value);
  group.onUpdate(updates => {
    if ('sourceName' in updates && updates.sourceName !== null) {
      const sourceNameSplit = updates.sourceName.split('.')[0];
      const analysisFilename = `data_analysis_${sourceNameSplit}.json`
      const pathData = filesystemAnalysis.getTree().children.find(e => e.name === analysisFilename).path;
      const analysisData = fs.readFileSync(pathData, 'utf8');
      group.set({
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
        await group.set({name: `group-${group.id}`});
        group.onUpdate(updates => {
          if ('sourceName' in updates) {
            const sourceNameSplit = updates.sourceName.split('.')[0];
            const analysisFilename = `data_analysis_${sourceNameSplit}.json`
            const pathData = filesystemAnalysis.getTree().children.find(e => e.name === analysisFilename).path;
            const analysisData = fs.readFileSync(pathData, 'utf8');
            group.set({sourceData: {
              name: updates.sourceName,
              data: analysisData 
            }});
          }
        });

        groups.set(group.id, group);
        saveGroups();
        break;
      }
      case 'createSingleGroup': {
        const group = await server.stateManager.create('group');
        await group.set({ name: `group-${group.id}` });
        group.onUpdate(updates => {
          if ('sourceName' in updates) {
            const sourceNameSplit = updates.sourceName.split('.')[0];
            const analysisFilename = `data_analysis_${sourceNameSplit}.json`
            const pathData = filesystemAnalysis.getTree().children.find(e => e.name === analysisFilename).path;
            const analysisData = fs.readFileSync(pathData, 'utf8');
            group.set({
              sourceData: {
                name: updates.sourceName,
                data: analysisData
              }
            });
          }
        });

        groups.set(group.id, group);
        satellites.forEach(satellite => {
          satellite.set({group: group.id});
        });
        saveGroups();
        break;
      }
      case 'createOneGroupPerClient': {
        satellites.forEach(async satellite => {
          const group = await server.stateManager.create('group', {
            name: satellite.get('name'),
          });
          group.onUpdate(updates => {
            if ('sourceName' in updates) {
              const sourceNameSplit = updates.sourceName.split('.')[0];
              const analysisFilename = `data_analysis_${sourceNameSplit}.json`
              const pathData = filesystemAnalysis.getTree().children.find(e => e.name === analysisFilename).path;
              const analysisData = fs.readFileSync(pathData, 'utf8');
              group.set({
                sourceData: {
                  name: updates.sourceName,
                  data: analysisData
                }
              });
            }
          });

          groups.set(group.id, group);
          satellite.set({ group: group.id });
          saveGroups();
        });
        break;
      }
      case 'deleteGroup': {
        const group = groups.get(value);
        groups.delete(group.id);
        await group.delete();
        saveGroups();
        break;
      }
    }
  });
});

satellites.onUpdate((state, updates) => {
  Object.entries(updates).forEach(([key, value]) => {
    switch (key) {
      case 'group':
        saveSatellitesGroupsMap();
        break;
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
      satellite.set({group: groupState.id});
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


