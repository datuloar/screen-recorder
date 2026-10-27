import { t } from './i18n.js';
export const clone = value => structuredClone(value);
export const duration = project => project.keep.reduce((sum, r) => sum + r.end_us - r.start_us, 0);
export function sourceTime(project, edited) {
  for (const r of project.keep) {
    const length = r.end_us - r.start_us;
    if (edited < length) return r.start_us + Math.max(0, edited);
    edited -= length;
  }
  return Math.max(0, project.keep.at(-1).end_us - 1);
}
export function editedTime(project, source) {
  let result = 0;
  for (const r of project.keep) {
    if (source < r.start_us) return result;
    if (source < r.end_us) return result + source - r.start_us;
    result += r.end_us - r.start_us;
  }
  return result;
}
export function cutRanges(keep, start, end, trim = false) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end) throw Error(t('The range must end after it starts'));
  const result = [];
  for (const r of keep) {
    if (trim) {
      const a = Math.max(start, r.start_us), b = Math.min(end, r.end_us);
      if (a < b) result.push({ start_us: a, end_us: b });
    } else if (end <= r.start_us || start >= r.end_us) result.push({ ...r });
    else {
      if (start > r.start_us) result.push({ start_us: r.start_us, end_us: start });
      if (end < r.end_us) result.push({ start_us: end, end_us: r.end_us });
    }
  }
  if (!result.length) throw Error(t('Keep at least one part of the video'));
  return result;
}
export function editTimeline(keep, start, end, retain = false) {
  const total = duration({keep});
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > total || start >= end) throw Error(t('Select a range within the edited video'));
  let offset = 0;
  const result = [];
  for (const range of keep) {
    const length = range.end_us - range.start_us;
    const left = Math.max(0, start - offset), right = Math.min(length, end - offset);
    if (left < right) {
      if (retain) result.push({start_us:range.start_us + left,end_us:range.start_us + right});
      else {
        if (left > 0) result.push({start_us:range.start_us,end_us:range.start_us + left});
        if (right < length) result.push({start_us:range.start_us + right,end_us:range.end_us});
      }
    } else if (!retain) result.push({...range});
    offset += length;
  }
  if (!result.length) throw Error(t('Keep at least one part of the video'));
  return result;
}
export function splitTimeline(keep, at) {
  if (!Number.isSafeInteger(at)) throw Error(t('Invalid split position'));
  let offset = 0, split = false;
  const result = keep.flatMap(range => {
    const length = range.end_us - range.start_us, local = at - offset;
    offset += length;
    if (local <= 0 || local >= length) return [{...range}];
    split = true;
    return [{start_us:range.start_us,end_us:range.start_us + local},{start_us:range.start_us + local,end_us:range.end_us}];
  });
  if (!split) throw Error(t('Move the playhead inside a clip to split it'));
  return result;
}
export function snapTime(at, fps, total) {
  return Math.max(0,Math.min(total,Math.round(Math.round(at * fps / 1e6) * 1e6 / fps)));
}
export function nearestPoint(at, points, tolerance, min, max) {
  let nearest=null,distance=tolerance;
  for(const point of points){
    const delta=Math.abs(point.at-at);
    if(point.at>=min && point.at<=max && delta<=distance && (!nearest || delta<distance)){
      nearest=point;distance=delta;
    }
  }
  return nearest;
}
export function parseTime(value) {
  const text = String(value).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw Error(t('Enter seconds, for example 12.5'));
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(result)) throw Error(t('Time value is too large'));
  return result;
}
export function seconds(us) { return String(Number((us / 1_000_000).toFixed(3))); }
export function timeInput(us) { return (Math.round(us) / 1_000_000).toFixed(6); }
export function clock(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}
export function fitRegion(rect, width, height) {
  const w = Math.max(2, Math.min(width & ~1, Math.round(rect.width) & ~1));
  const h = Math.max(2, Math.min(height & ~1, Math.round(rect.height) & ~1));
  return { x: Math.max(0, Math.min(width - w, Math.round(rect.x))), y: Math.max(0, Math.min(height - h, Math.round(rect.y))), width: w, height: h };
}
export function dragRegion(original, handle, dx, dy, width, height) {
  if (handle === 'move') return fitRegion({ ...original, x: original.x + dx, y: original.y + dy }, width, height);
  let x1 = original.x, y1 = original.y, x2 = x1 + original.width, y2 = y1 + original.height;
  if (handle.includes('w')) x1 = Math.max(0, Math.min(x2 - 2, x1 + dx));
  if (handle.includes('e')) x2 = Math.min(width, Math.max(x1 + 2, x2 + dx));
  if (handle.includes('n')) y1 = Math.max(0, Math.min(y2 - 2, y1 + dy));
  if (handle.includes('s')) y2 = Math.min(height, Math.max(y1 + 2, y2 + dy));
  return fitRegion({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, width, height);
}
