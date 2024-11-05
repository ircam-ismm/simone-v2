export default {
  presets: {
    type: 'any',
    default: true,
    nullable: true,
  },
  ledColor: {
    type: 'string',
    default: '#ffffff',
  },
  ledIntensity: {
    type: 'float',
    default: 0,
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
  saveGroupsSatellitesMap: {
    type: 'boolean',
    event: true,
  },
  deleteGroup: {
    type: 'integer',
    event: true,
  },
}