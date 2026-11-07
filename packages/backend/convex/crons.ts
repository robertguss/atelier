import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.interval('reclaim expired turn leases', { minutes: 1 }, internal.runner.reclaimExpiredLeases, {});

export default crons;
