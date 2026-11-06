import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Fails turns whose runner stopped renewing their lease, then moves each
// agent's queue on.
crons.interval('reclaim expired turn leases', { minutes: 1 }, internal.runner.reclaimExpiredLeases, {});

export default crons;
