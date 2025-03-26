export default {
  presets: {
    type: 'any',
    default: true,
    nullable: true,
  },
  ledColor: {
    type: 'string',
    default: '#00fa04',
  },
  ledIntensity: {
    type: 'float',
    default: 0.1,
    min: 0,
    max: 1,
  },
  createGroup: {
    type: 'boolean',
    event: true,
  },
  createSingleGroup: {
    type: 'boolean',
    event: true,
  },
  createOneGroupPerClient: {
    type: 'boolean',
    event: true,
  },
  saveGroupsSatellitesMap: {
    type: 'boolean',
    event: true,
  },
  deleteGroup: {
    type: 'integer',
    event: true,
  },
}
