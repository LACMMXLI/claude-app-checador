import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
app.enableShutdownHooks();
const port = Number(process.env.PORT ?? 3000);
await app.listen(port, '0.0.0.0');
console.log(`API escuchando en :${port}`);
