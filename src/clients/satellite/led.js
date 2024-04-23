export const config = {
  app: {
    name: 'dotpi-led',
    clients: {
      'dotpi-led-client': { target: 'node' },
    },
  },
  env: {
    type: 'development',
    port: 9999,
    serverAddress: '127.0.0.1',
    useHttps: false,
    verbose: true, //  process.env.VERBOSE === '1' ? true : false,
  },
};
