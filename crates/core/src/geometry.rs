use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl PixelRect {
    pub fn validate(self, width: u32, height: u32) -> Result<Self, String> {
        if self.width < 2 || self.height < 2 {
            return Err("The capture area must be at least 2 × 2 pixels".into());
        }
        if self.x.checked_add(self.width).is_none_or(|x| x > width)
            || self.y.checked_add(self.height).is_none_or(|y| y > height)
        {
            return Err("The capture area extends beyond the display".into());
        }
        Ok(self)
    }

    pub fn even_size(self) -> Self {
        Self {
            width: self.width & !1,
            height: self.height & !1,
            ..self
        }
    }

    pub fn from_points(
        a: (f32, f32),
        b: (f32, f32),
        scale: f64,
        bounds: (u32, u32),
    ) -> Option<Self> {
        if !scale.is_finite() || scale <= 0.0 || [a.0, a.1, b.0, b.1].iter().any(|v| !v.is_finite())
        {
            return None;
        }
        let clamp = |n: f32, max: u32| ((n as f64 * scale).round().max(0.0) as u32).min(max);
        let x1 = clamp(a.0.min(b.0), bounds.0);
        let y1 = clamp(a.1.min(b.1), bounds.1);
        let x2 = clamp(a.0.max(b.0), bounds.0);
        let y2 = clamp(a.1.max(b.1), bounds.1);
        let rect = Self {
            x: x1,
            y: y1,
            width: x2 - x1,
            height: y2 - y1,
        }
        .even_size();
        rect.validate(bounds.0, bounds.1).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reversed_retina_selection_stays_inside_display() {
        let r = PixelRect::from_points((100.5, 80.5), (1.0, -8.0), 2.0, (200, 160)).unwrap();
        assert_eq!(
            r,
            PixelRect {
                x: 2,
                y: 0,
                width: 198,
                height: 160
            }
        );
    }

    #[test]
    fn rejects_coordinate_overflow() {
        assert!(
            PixelRect {
                x: u32::MAX,
                y: 0,
                width: 20,
                height: 20
            }
            .validate(1920, 1080)
            .is_err()
        );
    }
}
