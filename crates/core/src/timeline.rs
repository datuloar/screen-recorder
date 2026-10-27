use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeRange {
    pub start_us: u64,
    pub end_us: u64,
}

impl TimeRange {
    pub fn new(start_us: u64, end_us: u64) -> Result<Self, String> {
        if start_us >= end_us {
            return Err("The clip must end after it starts".into());
        }
        Ok(Self { start_us, end_us })
    }

    pub fn duration_us(self) -> u64 {
        self.end_us.saturating_sub(self.start_us)
    }

    pub fn subtract(self, cut: Self) -> Vec<Self> {
        if cut.end_us <= self.start_us || cut.start_us >= self.end_us {
            return vec![self];
        }
        let mut result = Vec::new();
        if cut.start_us > self.start_us {
            result.push(Self {
                start_us: self.start_us,
                end_us: cut.start_us,
            });
        }
        if cut.end_us < self.end_us {
            result.push(Self {
                start_us: cut.end_us,
                end_us: self.end_us,
            });
        }
        result
    }
}

#[derive(Debug)]
pub struct RecordingClock {
    started: Instant,
    paused_at: Option<Instant>,
    paused: Duration,
    pauses: Vec<(Instant, Instant)>,
}

impl Default for RecordingClock {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            paused_at: None,
            paused: Duration::ZERO,
            pauses: Vec::new(),
        }
    }
}

impl RecordingClock {
    pub fn starting_at(started: Instant) -> Self {
        Self {
            started,
            paused_at: None,
            paused: Duration::ZERO,
            pauses: Vec::new(),
        }
    }
    pub fn pause(&mut self) {
        self.paused_at.get_or_insert_with(Instant::now);
    }
    pub fn resume(&mut self) {
        if let Some(t) = self.paused_at.take() {
            let now = Instant::now();
            self.paused += now.duration_since(t);
            self.pauses.push((t, now));
        }
    }
    pub fn is_paused(&self) -> bool {
        self.paused_at.is_some()
    }
    pub fn elapsed(&self) -> Duration {
        self.paused_at
            .unwrap_or_else(Instant::now)
            .duration_since(self.started)
            .saturating_sub(self.paused)
    }

    pub fn capture_slices(&self, start: Instant, frames: u32, rate: u32) -> Vec<CaptureSlice> {
        if rate == 0 || frames == 0 {
            return Vec::new();
        }
        let end =
            start + Duration::from_nanos((frames as u128 * 1_000_000_000 / rate as u128) as u64);
        let mut cursor = start.max(self.started);
        let mut active = Vec::new();
        for &(a, b) in &self.pauses {
            if b <= cursor {
                continue;
            }
            if a >= end {
                break;
            }
            if a > cursor {
                active.push((cursor, a.min(end)));
            }
            cursor = cursor.max(b);
            if cursor >= end {
                break;
            }
        }
        let active_end = self.paused_at.map_or(end, |p| end.min(p));
        if cursor < active_end {
            active.push((cursor, active_end));
        }
        active
            .into_iter()
            .filter_map(|(a, b)| {
                let to_index = |t: Instant| {
                    ((t.saturating_duration_since(start).as_nanos() * rate as u128)
                        .div_ceil(1_000_000_000))
                    .min(frames as u128) as u32
                };
                let first = to_index(a);
                let last = to_index(b);
                let at = start
                    + Duration::from_nanos((first as u128 * 1_000_000_000 / rate as u128) as u64);
                let paused: Duration = self
                    .pauses
                    .iter()
                    .filter(|(_, b)| *b <= at)
                    .map(|(a, b)| b.duration_since(*a))
                    .sum();
                (last > first).then(|| CaptureSlice {
                    offset_frames: first,
                    frames: last - first,
                    position: at
                        .saturating_duration_since(self.started)
                        .saturating_sub(paused),
                })
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureSlice {
    pub offset_frames: u32,
    pub frames: u32,
    pub position: Duration,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_packet_spanning_pause_is_split_on_shared_timeline() {
        let start = Instant::now();
        let clock = RecordingClock {
            started: start,
            paused_at: None,
            paused: Duration::from_millis(200),
            pauses: vec![(
                start + Duration::from_millis(100),
                start + Duration::from_millis(300),
            )],
        };
        let slices = clock.capture_slices(start, 480, 1000);
        assert_eq!(
            slices,
            vec![
                CaptureSlice {
                    offset_frames: 0,
                    frames: 100,
                    position: Duration::ZERO
                },
                CaptureSlice {
                    offset_frames: 300,
                    frames: 180,
                    position: Duration::from_millis(100)
                }
            ]
        );
        let before = clock.capture_slices(start - Duration::from_millis(50), 100, 1000);
        assert_eq!(
            before,
            vec![CaptureSlice {
                offset_frames: 50,
                frames: 50,
                position: Duration::ZERO
            }]
        );
    }

    #[test]
    fn removing_middle_keeps_original_source_times() {
        let remaining = TimeRange::new(0, 10_000)
            .unwrap()
            .subtract(TimeRange::new(2_000, 8_000).unwrap());
        assert_eq!(
            remaining,
            vec![
                TimeRange {
                    start_us: 0,
                    end_us: 2_000
                },
                TimeRange {
                    start_us: 8_000,
                    end_us: 10_000
                }
            ]
        );
    }

    #[test]
    fn cuts_outside_range_do_not_expand_it() {
        let source = TimeRange::new(20, 80).unwrap();
        assert!(source.subtract(TimeRange::new(0, 100).unwrap()).is_empty());
        assert_eq!(
            source.subtract(TimeRange::new(80, 90).unwrap()),
            vec![source]
        );
    }
}
