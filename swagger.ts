import swaggerAutogen from 'swagger-autogen';

const doc = {
  info: {
    title: 'OFFITEC ERP API',
    description: 'Otomatik Üretilen API Dokümantasyonu',
  },
  host: 'localhost:3000',
  basePath: '/api/v1', 
  schemes: ['http'],
};

const outputFile = './swagger-output.json';
const endpointsFiles = ['./src/presentation/routes/*.ts']; 

swaggerAutogen()(outputFile, endpointsFiles, doc);