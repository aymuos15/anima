import serverless from 'serverless-http'
import { server } from '../../agent/server.js'

export const handler = serverless(server)
