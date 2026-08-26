/**
 * Body-metrics & progress-photo data service.
 *
 * Single access point for body measurements and progress photos. UI code
 * must import from here, never from `../db/*` directly. Thin facade over
 * the local SQLite modules.
 */
export {
  logBodyMetric,
  getBodyWeightHistory,
  getTodayBodyMetric,
  getAllBodyMetricsForDate,
  BODY_METRIC_TYPES,
} from '../db/body';
export {
  addProgressPhoto,
  getProgressPhotos,
  deleteProgressPhoto,
  getPhotoFilePath,
} from '../db/photos';
