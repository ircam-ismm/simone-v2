export default {
  name: {
    type: 'string',
    default: null,
    nullable: true,
  },
  color: {
    type: 'string',
    default: '#000000',
  },
  sourceName: {
    type: 'string',
    default: null,
    nullable: true,
  }, 
  sourceState: {
    type: 'integer',
    default: null,
    nullable: true
  },
  playing: {
    type: 'boolean',
    default: false,
  },
  volume: {
    type: 'float',
    default: 0,
    min: -70,
    max: 0,
  },
  detune: {
    type: 'float',
    default: 0,
    min: -12,
    max: 12,
  },
  grainPeriod: {
    type: 'float',
    default: 0.1,
    min: 0.05,
    max: 0.5,
  },
  grainDuration: {
    type: 'float',
    default: 0.25,
    min: 0.02,
    max: 0.5,
  },
  randomizer: {
    type: 'float',
    default: 1,
    min: 1,
    max: 10,
  },
}