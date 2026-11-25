// DK-6 AC1: the icon of the menu bar and of the notification area, drawn here pixel by pixel for
// each look and each frame of the working wave.
use std::f32::consts::TAU;
use std::sync::OnceLock;
use tauri::image::Image;

use super::{Look, Tray, HERE};

/// 18 points at 2x, the menu bar's height; Windows scales it to its own 16 pixels, or more on a
/// denser screen.
const SIZE: u32 = 36;
/// Supersampling per axis, for smooth edges.
const SAMPLES: u32 = 4;
/// How a mark that is not running is dimmed, as macOS dims an inactive menu bar item.
const DIMMED: f32 = 0.42;

/// In the menu bar, a template image: black, with the shape in the alpha channel, so macOS tints
/// it for the light and dark menu bars. On the taskbar, the same shape drawn light with a dark
/// rim, so it reads on a light taskbar and on a dark one. The mark is always ANOMANDER's "A", so the icon is recognised whatever the
/// state; the state is how it is drawn (DK-6 AC1):
/// - running: the solid mark;
/// - stopped: the mark dimmed;
/// - starting: the mark dimmed, with a small ring that says something is on its way;
/// - working: the solid mark and, beside it, three dots that rise and brighten one after another
///   in a wave, as a chat shows the other side typing; `frame` is the moment of the turn. The
///   taskbar's icon is square, so there the dots take the badge's corner;
/// - failing: the solid mark with an exclamation badge.
///
/// `SIZE` is 18 points at 2x: the tray scales the image to the menu bar's 18 points, so it is
/// drawn sharp on a Retina screen.
pub fn icon(look: Look, frame: u8) -> Image<'static> {
    if look == Look::Working {
        let rgba: &'static [u8] = &working_frames()[usize::from(frame % FRAMES)];
        return Image::new(rgba, width(HERE, look), SIZE);
    }
    Image::new_owned(icon_rgba(HERE, look, frame), width(HERE, look), SIZE)
}

/// The frames of one turn of the working wave.
pub const FRAMES: u8 = 36;
/// The room the dots take beside the mark.
const DOTS_WIDTH: u32 = 30;

/// Where the row of working dots goes, and how big they are.
struct Row {
    first: f32,
    apart: f32,
    line: f32,
    rise: f32,
    radius: f32,
}

/// In the menu bar the dots sit beside the mark, in the room `DOTS_WIDTH` adds.
const BESIDE: Row = Row {
    first: 41.0,
    apart: 9.0,
    line: 23.0,
    rise: 5.0,
    radius: 3.0,
};
/// On the taskbar the icon is square: the dots take the corner a badge would, smaller.
const IN_THE_CORNER: Row = Row {
    first: 23.5,
    apart: 5.0,
    line: 10.5,
    rise: 4.0,
    radius: 2.0,
};
/// How far around the badge's centre the mark gives way to the dots in the corner.
const CORNER_CLEARING: f32 = 9.0;

/// Every frame of the working wave, drawn once: a frame is then a lookup, not a render.
pub(super) fn working_frames() -> &'static [Vec<u8>] {
    static FRAMES_RGBA: OnceLock<Vec<Vec<u8>>> = OnceLock::new();
    FRAMES_RGBA.get_or_init(|| {
        (0..FRAMES)
            .map(|frame| icon_rgba(HERE, Look::Working, frame))
            .collect()
    })
}

/// The icon's width: in the menu bar the dots sit beside the mark, so the working icon is wider.
fn width(tray: Tray, look: Look) -> u32 {
    if tray == Tray::MenuBar && look == Look::Working {
        SIZE + DOTS_WIDTH
    } else {
        SIZE
    }
}

/// Where one dot is at a frame: how far it has risen, 0 to 1, and how opaque it is.
///
/// Each dot in turn lifts and brightens along a sine hump, so it leaves the line and lands on it
/// with no velocity, and the three overlap into one wave that travels right; the row then rests
/// a moment before the next turn.
fn dot_pose(frame: u8, dot: u8) -> (f32, f32) {
    /// The part of a turn one dot spends up.
    const HUMP: f32 = 0.5;
    /// How far behind the previous dot each one starts, as part of a turn.
    const BEHIND: f32 = 0.17;
    /// How opaque a dot is on the line.
    const WAITING: f32 = 0.5;
    let turn = f32::from(frame % FRAMES) / f32::from(FRAMES) - BEHIND * f32::from(dot);
    let along = turn.rem_euclid(1.0) / HUMP;
    let lift = if along < 1.0 {
        (1.0 - (TAU * along).cos()) / 2.0
    } else {
        0.0
    };
    (lift, WAITING + (1.0 - WAITING) * lift)
}

/// How opaque the dots of `row` are at a point.
fn dots(row: &Row, frame: u8, x: f32, y: f32) -> f32 {
    (0..3u8)
        .map(|dot| {
            let (lift, alpha) = dot_pose(frame, dot);
            let (cx, cy) = (
                row.first + row.apart * f32::from(dot),
                row.line - row.rise * lift,
            );
            if (x - cx).hypot(y - cy) <= row.radius {
                alpha
            } else {
                0.0
            }
        })
        .fold(0.0, f32::max)
}

fn icon_rgba(tray: Tray, look: Look, frame: u8) -> Vec<u8> {
    let width = width(tray, look);
    let mut shape = Vec::with_capacity((width * SIZE) as usize);
    for y in 0..SIZE {
        for x in 0..width {
            let mut total = 0.0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let px = x as f32 + (sx as f32 + 0.5) / SAMPLES as f32;
                    let py = y as f32 + (sy as f32 + 0.5) / SAMPLES as f32;
                    total += opacity(tray, look, frame, px, py);
                }
            }
            shape.push((total / (SAMPLES * SAMPLES) as f32 * 255.0).round() as u8);
        }
    }
    match tray {
        Tray::MenuBar => shape.iter().flat_map(|alpha| [0, 0, 0, *alpha]).collect(),
        Tray::Taskbar => rimmed(&shape, width),
    }
}

/// How far the dark rim reaches around the shape, in pixels: about one pixel once Windows scales
/// the icon to 16.
const RIM: i32 = 2;

/// The shape, given as one alpha per pixel, drawn white over a black rim: the white reads on a
/// dark taskbar and the rim on a light one. The rim's strength at a pixel is the strongest shape
/// within `RIM` of it, so a dimmed mark has a dimmed rim.
fn rimmed(shape: &[u8], width: u32) -> Vec<u8> {
    let (width, height) = (width as i32, SIZE as i32);
    let at = |x: i32, y: i32| {
        if (0..width).contains(&x) && (0..height).contains(&y) {
            shape[(y * width + x) as usize]
        } else {
            0
        }
    };
    let mut rgba = Vec::with_capacity(shape.len() * 4);
    for y in 0..height {
        for x in 0..width {
            let mut rim = 0u8;
            for dy in -RIM..=RIM {
                for dx in -RIM..=RIM {
                    if dx * dx + dy * dy <= RIM * RIM {
                        rim = rim.max(at(x + dx, y + dy));
                    }
                }
            }
            let fill = f32::from(at(x, y)) / 255.0;
            let rim = f32::from(rim) / 255.0;
            // White over black: the colour is the fill's share of what covers the pixel.
            let alpha = fill + rim * (1.0 - fill);
            let light = if alpha > 0.0 { fill / alpha } else { 0.0 };
            let channel = (light * 255.0).round() as u8;
            rgba.extend_from_slice(&[channel, channel, channel, (alpha * 255.0).round() as u8]);
        }
    }
    rgba
}

/// The distance from a point to the segment from `a` to `b`: a stroke with round ends is every
/// point closer than half its width.
fn distance_to_segment(point: (f32, f32), a: (f32, f32), b: (f32, f32)) -> f32 {
    let (abx, aby) = (b.0 - a.0, b.1 - a.1);
    let (apx, apy) = (point.0 - a.0, point.1 - a.1);
    let along = ((apx * abx + apy * aby) / (abx * abx + aby * aby)).clamp(0.0, 1.0);
    let (dx, dy) = (apx - abx * along, apy - aby * along);
    (dx * dx + dy * dy).sqrt()
}

/// The "A": two legs from the apex and a crossbar.
fn in_mark(point: (f32, f32)) -> bool {
    const APEX: (f32, f32) = (18.0, 5.5);
    const LEFT_FOOT: (f32, f32) = (7.5, 30.0);
    const RIGHT_FOOT: (f32, f32) = (28.5, 30.0);
    const LEG: f32 = 2.5;
    const BAR: f32 = 2.0;
    distance_to_segment(point, APEX, LEFT_FOOT) <= LEG
        || distance_to_segment(point, APEX, RIGHT_FOOT) <= LEG
        || distance_to_segment(point, (11.5, 22.5), (24.5, 22.5)) <= BAR
}

/// How opaque the icon is at a point, from 0 to 1.
fn opacity(tray: Tray, look: Look, frame: u8, x: f32, y: f32) -> f32 {
    // The badge sits in the corner the mark leaves empty, where a notification badge goes, with
    // a clear gap around it so it reads at 18 points and the mark stays whole.
    const BADGE: (f32, f32) = (29.0, 7.5);
    const BADGE_RADIUS: f32 = 6.0;
    const GAP: f32 = 1.5;
    let (dx, dy) = (x - BADGE.0, y - BADGE.1);
    let from_badge = (dx * dx + dy * dy).sqrt();
    let mark = |strength: f32| if in_mark((x, y)) { strength } else { 0.0 };
    let badged_mark = |strength: f32| {
        if from_badge <= BADGE_RADIUS + GAP {
            0.0
        } else {
            mark(strength)
        }
    };
    match look {
        Look::Running => mark(1.0),
        Look::Stopped => mark(DIMMED),
        Look::Working if tray == Tray::MenuBar => mark(1.0).max(dots(&BESIDE, frame, x, y)),
        Look::Working => {
            let dots = dots(&IN_THE_CORNER, frame, x, y);
            if from_badge <= CORNER_CLEARING {
                dots
            } else {
                mark(1.0).max(dots)
            }
        }
        Look::Starting => {
            if (BADGE_RADIUS - 2.3..=BADGE_RADIUS).contains(&from_badge) {
                1.0
            } else {
                badged_mark(DIMMED)
            }
        }
        Look::Failing => {
            let bar = dx.abs() <= 1.2 && (-3.9..=0.6).contains(&dy);
            let dot = dx.abs() <= 1.2 && (2.2..=4.2).contains(&dy);
            if from_badge <= BADGE_RADIUS {
                if bar || dot {
                    0.0
                } else {
                    1.0
                }
            } else {
                badged_mark(1.0)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strongest(rgba: &[u8]) -> u8 {
        rgba.chunks(4).map(|pixel| pixel[3]).max().unwrap_or(0)
    }

    #[test]
    fn each_state_has_its_own_template_icon() {
        let looks = [
            Look::Running,
            Look::Working,
            Look::Stopped,
            Look::Starting,
            Look::Failing,
        ];
        let icons: Vec<Vec<u8>> = looks
            .iter()
            .map(|look| icon_rgba(Tray::MenuBar, *look, 0))
            .collect();
        for (index, rgba) in icons.iter().enumerate() {
            assert_eq!(
                rgba.len(),
                (width(Tray::MenuBar, looks[index]) * SIZE * 4) as usize
            );
            // Template images: only the alpha channel carries the shape.
            assert!(rgba.chunks(4).all(|pixel| pixel[..3] == [0, 0, 0]));
            for other in &icons[index + 1..] {
                assert_ne!(rgba, other);
            }
        }
    }

    #[test]
    fn a_stopped_mark_is_dimmed_and_a_running_one_is_solid() {
        assert_eq!(strongest(&icon_rgba(Tray::MenuBar, Look::Running, 0)), 255);
        let dimmed = strongest(&icon_rgba(Tray::MenuBar, Look::Stopped, 0));
        assert!((90..=120).contains(&dimmed), "dimmed alpha was {dimmed}");
        // The badges are solid even on a dimmed mark, so they are what the eye finds.
        assert_eq!(strongest(&icon_rgba(Tray::MenuBar, Look::Starting, 0)), 255);
        assert_eq!(strongest(&icon_rgba(Tray::MenuBar, Look::Failing, 0)), 255);
    }

    /// Fails unless the icon's outermost rows and columns are clear.
    fn assert_clear_edge(rgba: &[u8], width: u32) {
        let alpha = |x: u32, y: u32| rgba[((y * width + x) * 4 + 3) as usize];
        for x in 0..width {
            assert_eq!(alpha(x, 0), 0);
            assert_eq!(alpha(x, SIZE - 1), 0);
        }
        for y in 0..SIZE {
            assert_eq!(alpha(0, y), 0);
            assert_eq!(alpha(width - 1, y), 0);
        }
    }

    #[test]
    fn the_mark_stays_inside_the_icon_with_a_clear_edge() {
        for look in [Look::Running, Look::Failing, Look::Starting, Look::Stopped] {
            assert_clear_edge(
                &icon_rgba(Tray::MenuBar, look, 0),
                width(Tray::MenuBar, look),
            );
        }
    }

    #[test]
    fn every_frame_of_the_wave_is_a_template_image_of_the_working_size() {
        let wide = width(Tray::MenuBar, Look::Working);
        for frame in 0..FRAMES {
            let rgba = icon_rgba(Tray::MenuBar, Look::Working, frame);
            assert_eq!(rgba.len(), (wide * SIZE * 4) as usize);
            assert!(rgba.chunks(4).all(|pixel| pixel[..3] == [0, 0, 0]));
            assert_clear_edge(&rgba, wide);
        }
    }

    #[test]
    fn the_icon_hands_out_the_cached_frames_of_this_tray() {
        let wide = width(HERE, Look::Working);
        let frames = working_frames();
        assert_eq!(frames.len(), usize::from(FRAMES));
        for (index, rgba) in frames.iter().enumerate() {
            // The cache is the drawing, frame for frame.
            assert_eq!(*rgba, icon_rgba(HERE, Look::Working, index as u8));
        }
        // The icon hands out the cached frame, and turns over after the last.
        let image = icon(Look::Working, FRAMES + 2);
        assert_eq!((image.width(), image.height()), (wide, SIZE));
        assert_eq!(image.rgba(), frames[2].as_slice());
    }

    /// The alpha of the icon's columns from `from` on, row by row.
    fn columns(rgba: &[u8], width: u32, from: u32, to: u32) -> Vec<u8> {
        (0..SIZE)
            .flat_map(|y| (from..to).map(move |x| (y * width + x) * 4 + 3))
            .map(|index| rgba[index as usize])
            .collect()
    }

    #[test]
    fn working_keeps_the_mark_whole_and_puts_the_dots_beside_it() {
        let wide = width(Tray::MenuBar, Look::Working);
        assert!(wide > SIZE);
        let running = icon_rgba(Tray::MenuBar, Look::Running, 0);
        for frame in 0..FRAMES {
            let working = icon_rgba(Tray::MenuBar, Look::Working, frame);
            assert_eq!(
                columns(&working, wide, 0, SIZE),
                columns(&running, SIZE, 0, SIZE)
            );
        }
        // Somewhere in the turn a dot is solid, and at rest none is.
        let (first, peak) = (
            icon_rgba(Tray::MenuBar, Look::Working, 0),
            icon_rgba(Tray::MenuBar, Look::Working, 9),
        );
        assert!(columns(&peak, wide, SIZE, wide).contains(&255));
        assert!(!columns(&first, wide, SIZE, wide).contains(&255));
        assert_ne!(first, peak);
        // The frame after the last is the first again.
        assert_eq!(icon_rgba(Tray::MenuBar, Look::Working, FRAMES), first);
    }

    #[test]
    fn the_idle_looks_do_not_move() {
        for look in [Look::Running, Look::Stopped, Look::Starting, Look::Failing] {
            assert_eq!(
                icon_rgba(Tray::MenuBar, look, 0),
                icon_rgba(Tray::MenuBar, look, 17)
            );
        }
    }

    /// The lift of `dot` at each frame of a turn.
    fn lifts(dot: u8) -> Vec<f32> {
        (0..FRAMES).map(|frame| dot_pose(frame, dot).0).collect()
    }

    #[test]
    fn the_dots_rise_in_turn_along_a_smooth_wave_and_rest_between_turns() {
        let peak_of = |dot: u8| {
            let lifts = lifts(dot);
            (0..lifts.len())
                .max_by(|a, b| lifts[*a].total_cmp(&lifts[*b]))
                .unwrap()
        };
        // One after another, left to right.
        assert!(peak_of(0) < peak_of(1) && peak_of(1) < peak_of(2));
        for dot in 0..3 {
            let lifts = lifts(dot);
            // Each goes all the way up and comes back to the line.
            assert!(lifts.iter().cloned().fold(0.0, f32::max) > 0.95);
            assert_eq!(lifts[0], 0.0);
            // And moves a little at a time: no frame jumps more than a fifth of the rise.
            for pair in lifts.windows(2) {
                assert!((pair[1] - pair[0]).abs() <= 0.2, "{pair:?}");
            }
            let (_, alpha_at_rest) = dot_pose(0, dot);
            assert_eq!(alpha_at_rest, 0.5);
        }
        // The turn ends with the row at rest for a moment before it starts again.
        let at_rest = |frame: u8| (0..3).all(|dot| dot_pose(frame, dot).0 == 0.0);
        assert!(at_rest(FRAMES - 1) && at_rest(0));
        assert!(!at_rest(FRAMES / 2));
    }

    /// How light each pixel of `rgba` looks over a background of grey `background`, 0 to 255.
    fn over(rgba: &[u8], background: u8) -> Vec<u8> {
        rgba.chunks(4)
            .map(|pixel| {
                let alpha = f32::from(pixel[3]) / 255.0;
                let blended = f32::from(pixel[0]) * alpha + f32::from(background) * (1.0 - alpha);
                blended.round() as u8
            })
            .collect()
    }

    #[test]
    fn on_the_taskbar_every_icon_is_square_and_reads_on_a_light_and_a_dark_taskbar() {
        for look in [
            Look::Running,
            Look::Working,
            Look::Stopped,
            Look::Starting,
            Look::Failing,
        ] {
            assert_eq!(width(Tray::Taskbar, look), SIZE);
            let rgba = icon_rgba(Tray::Taskbar, look, 9);
            assert_eq!(rgba.len(), (SIZE * SIZE * 4) as usize);
            // Something light on a black taskbar, and something dark on a white one.
            let on_dark = over(&rgba, 0).into_iter().max().unwrap_or(0);
            let on_light = over(&rgba, 255).into_iter().min().unwrap_or(255);
            if look == Look::Stopped {
                assert!(on_dark >= 90 && on_light <= 165, "{look:?}");
            } else {
                assert!(on_dark >= 250 && on_light <= 5, "{look:?}");
            }
        }
    }

    #[test]
    fn on_the_taskbar_the_mark_is_light_inside_a_dark_rim() {
        let rgba = icon_rgba(Tray::Taskbar, Look::Running, 0);
        let pixel = |x: u32, y: u32| &rgba[((y * SIZE + x) * 4) as usize..][..4];
        // The middle of the crossbar is the mark: white and solid.
        assert_eq!(pixel(18, 22), [255, 255, 255, 255]);
        // Just under it is the rim: black and solid.
        assert_eq!(pixel(18, 25), [0, 0, 0, 255]);
        // Further off, nothing.
        assert_eq!(pixel(18, 28)[3], 0);
        // The same shapes as the menu bar's, with the rim around them.
        let template = icon_rgba(Tray::MenuBar, Look::Running, 0);
        for (drawn, shape) in rgba.chunks(4).zip(template.chunks(4)) {
            assert!(drawn[3] >= shape[3]);
        }
    }

    #[test]
    fn on_the_taskbar_the_dots_wave_in_the_corner_and_the_mark_gives_way_to_them() {
        let at_rest = icon_rgba(Tray::Taskbar, Look::Working, 0);
        let peak = icon_rgba(Tray::Taskbar, Look::Working, 9);
        assert_ne!(at_rest, peak);
        // Only the corner moves: the rest of the icon is the mark at every frame.
        let corner = |x: u32, y: u32| {
            (x as f32 + 0.5 - 29.0).hypot(y as f32 + 0.5 - 7.5) <= CORNER_CLEARING + RIM as f32
        };
        let running = icon_rgba(Tray::Taskbar, Look::Running, 0);
        for frame in 0..FRAMES {
            let working = icon_rgba(Tray::Taskbar, Look::Working, frame);
            for y in 0..SIZE {
                for x in 0..SIZE {
                    if !corner(x, y) {
                        let index = ((y * SIZE + x) * 4) as usize;
                        assert_eq!(working[index..index + 4], running[index..index + 4]);
                    }
                }
            }
        }
    }

    #[test]
    fn the_menu_bar_stays_a_template_image() {
        assert_eq!(HERE == Tray::MenuBar, cfg!(target_os = "macos"));
        assert!(icon_rgba(Tray::MenuBar, Look::Failing, 0)
            .chunks(4)
            .all(|pixel| pixel[..3] == [0, 0, 0]));
    }
}
