export default {
  analysisData: {
    type: 'any',
    default: null,
    nullable: true,
  },
  loadCalibrationFile: {
    type: 'string',
    default: null,
    nullable: true,
  },
  calibrationFileRead: {
    type: 'any',
    default: null,
    nullable: true,
  },
  loadAnalysisFile: {
    type: 'string',
    default: null,
    nullable: true,
  },
  analysisFileRead: {
    type: 'any',
    default: null,
    nullable: true,
  },
  grainPeriod: {
    type: 'float',
    default: 0.1,
    min: 0.01,
    max: 0.5,
  },
  grainDuration: {
    type: 'float',
    default: 0.25,
    min: 0.02,
    max: 0.5,
  },
  volume: {
    type: 'float',
    default: 0,
    min: -70,
    max: 0,
  },
}