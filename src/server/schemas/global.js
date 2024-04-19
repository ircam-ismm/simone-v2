export default {
  presets: {
    type: 'any',
    default: true,
    nullable: true,
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
  deleteGroup: {
    type: 'integer',
    event: true,
  },
}