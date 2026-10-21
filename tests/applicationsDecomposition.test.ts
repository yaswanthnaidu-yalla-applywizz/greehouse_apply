import { describe, it, expect } from 'vitest';
import {
  getApplication,
  upsertApplication,
  updateStatus,
  countSubmittedApplicationsSince,
  getNextQueuedApplicationForRoundRobin,
  getRecentNotifications,
  serializeApplicationDto,
  IN_FLIGHT_STATUSES,
} from '../src/db/applications.js';

import { getApplication as getAppFromCrud } from '../src/db/applications/crud.js';
import { countSubmittedApplicationsSince as countFromStats } from '../src/db/applications/statsQueries.js';
import { getNextQueuedApplicationForRoundRobin as getNextFromQueue } from '../src/db/applications/queue.js';
import { getRecentNotifications as getNotifsFromNotifs } from '../src/db/applications/notifications.js';
import { serializeApplicationDto as serializeFromDto } from '../src/db/applications/dto.js';
import { IN_FLIGHT_STATUSES as inFlightFromTypes } from '../src/db/applications/types.js';

describe('Applications Decomposition Modules', () => {
  it('exports functions from barrel applications.js matching submodules', () => {
    expect(getApplication).toBe(getAppFromCrud);
    expect(countSubmittedApplicationsSince).toBe(countFromStats);
    expect(getNextQueuedApplicationForRoundRobin).toBe(getNextFromQueue);
    expect(getRecentNotifications).toBe(getNotifsFromNotifs);
    expect(serializeApplicationDto).toBe(serializeFromDto);
    expect(IN_FLIGHT_STATUSES).toBe(inFlightFromTypes);
  });
});
