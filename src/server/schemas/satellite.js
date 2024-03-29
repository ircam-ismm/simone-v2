export default {
  name: {
    type: 'string',
    default: null,
    nullable: true,
  },
  group: {
    type: 'integer',
    default: null,
    nullable: true,
  },
  reboot: {
    type: 'boolean',
    event: true,
  },
  loadAnalysisData: {
    type: 'string',
    event: true,
  },
  loadSource: {
    type: 'any',
    event: true,
  }
}