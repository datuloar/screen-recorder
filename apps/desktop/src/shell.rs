use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState, hotkey::HotKey};
use tray_icon::{
    Icon, TrayIcon, TrayIconBuilder,
    menu::{Menu, MenuEvent, MenuItem},
};

#[derive(Debug, Clone, Copy)]
pub enum ShellEvent {
    Show,
    Recent,
    Last,
    Settings,
    Select,
    Stop,
    Pause,
    Quit,
    HotkeyCaptured(HotKey),
}

pub struct Shell {
    _tray: TrayIcon,
    manager: GlobalHotKeyManager,
    keys: [HotKey; 3],
    labels: [(MenuItem, &'static str, &'static str); 8],
}

static EVENTS: std::sync::OnceLock<tokio::sync::broadcast::Sender<ShellEvent>> =
    std::sync::OnceLock::new();

static KEY_CAPTURE: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

pub fn capture_keys(enabled: bool) {
    *KEY_CAPTURE.lock().unwrap() = enabled.then(std::time::Instant::now);
}

fn is_capturing() -> bool {
    KEY_CAPTURE
        .lock()
        .unwrap()
        .is_some_and(|at| at.elapsed().as_secs() < 30)
}

pub fn events() -> &'static tokio::sync::broadcast::Sender<ShellEvent> {
    EVENTS.get_or_init(|| tokio::sync::broadcast::channel(32).0)
}

impl Shell {
    pub fn new(settings: &recorder_core::AppSettings) -> anyhow::Result<Self> {
        let menu = Menu::new();
        let select = MenuItem::new("New recording", true, None);
        let show = MenuItem::new("Open Screen Recorder", true, None);
        let recent = MenuItem::new("Recent recordings", true, None);
        let last = MenuItem::new("Open last recording", true, None);
        let settings_item = MenuItem::new("Settings", true, None);
        let stop = MenuItem::new("Stop recording", true, None);
        let pause = MenuItem::new("Pause / resume", true, None);
        let quit = MenuItem::new("Quit", true, None);
        menu.append_items(&[
            &select,
            &show,
            &last,
            &recent,
            &pause,
            &stop,
            &settings_item,
            &quit,
        ])?;
        let ids = [
            (select.id().clone(), ShellEvent::Select),
            (show.id().clone(), ShellEvent::Show),
            (recent.id().clone(), ShellEvent::Recent),
            (last.id().clone(), ShellEvent::Last),
            (settings_item.id().clone(), ShellEvent::Settings),
            (stop.id().clone(), ShellEvent::Stop),
            (pause.id().clone(), ShellEvent::Pause),
            (quit.id().clone(), ShellEvent::Quit),
        ];
        let labels = [
            (select, "New recording", "Новая запись"),
            (show, "Open Screen Recorder", "Открыть Screen Recorder"),
            (recent, "Recent recordings", "Недавние записи"),
            (last, "Open last recording", "Открыть последнюю запись"),
            (settings_item, "Settings", "Настройки"),
            (stop, "Stop recording", "Остановить запись"),
            (pause, "Pause / resume", "Пауза / продолжить"),
            (quit, "Quit", "Выход"),
        ];
        for (item, en, ru) in &labels {
            item.set_text(crate::language::text(settings.language, en, ru));
        }
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            if let Some((_, action)) = ids.iter().find(|(id, _)| *id == event.id) {
                let _ = events().send(*action);
            }
        }));
        // A recording glyph identifies the tray action; branding can be supplied later.
        let mut rgba = vec![0u8; 32 * 32 * 4];
        for y in 0..32 {
            for x in 0..32 {
                let d = (x as i32 - 16).pow(2) + (y as i32 - 16).pow(2);
                if d < 144 {
                    let i = (y * 32 + x) * 4;
                    rgba[i..i + 4].copy_from_slice(&[218, 55, 65, 255]);
                }
            }
        }
        let tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("Screen Recorder")
            .with_icon(Icon::from_rgba(rgba, 32, 32)?)
            .build()?;
        let manager = GlobalHotKeyManager::new()?;
        let keys = Self::parse_keys(settings)?;
        manager.register_all(&keys)?;
        Self::listen(keys);
        Ok(Self {
            _tray: tray,
            manager,
            keys,
            labels,
        })
    }

    fn parse_keys(settings: &recorder_core::AppSettings) -> anyhow::Result<[HotKey; 3]> {
        let keys = [
            settings.hotkey.parse()?,
            settings.stop_hotkey.parse()?,
            settings.pause_hotkey.parse()?,
        ];
        anyhow::ensure!(
            keys[0] != keys[1] && keys[0] != keys[2] && keys[1] != keys[2],
            "Each action needs a different keyboard shortcut"
        );
        Ok(keys)
    }

    pub fn rebind(&mut self, settings: &recorder_core::AppSettings) -> anyhow::Result<()> {
        let keys = Self::parse_keys(settings)?;
        if keys == self.keys {
            self.set_language(settings.language);
            return Ok(());
        }
        self.manager.unregister_all(&self.keys)?;
        if let Err(error) = self.manager.register_all(&keys) {
            let _ = self.manager.unregister_all(&keys);
            self.manager.register_all(&self.keys)?;
            anyhow::bail!(
                "Could not assign shortcut. Another app may be using it. Previous shortcuts restored. {error}"
            );
        }
        self.keys = keys;
        Self::listen(keys);
        self.set_language(settings.language);
        Ok(())
    }

    fn set_language(&self, language: recorder_core::Language) {
        for (item, en, ru) in &self.labels {
            item.set_text(crate::language::text(language, en, ru));
        }
    }

    fn listen([record, stop, pause]: [HotKey; 3]) {
        GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
            if event.state == HotKeyState::Pressed {
                let Some(key) = [record, stop, pause]
                    .into_iter()
                    .find(|key| key.id() == event.id)
                else {
                    return;
                };
                if is_capturing() {
                    let _ = events().send(ShellEvent::HotkeyCaptured(key));
                    return;
                }
                let action = if event.id == record.id() {
                    ShellEvent::Select
                } else if event.id == stop.id() {
                    ShellEvent::Stop
                } else {
                    ShellEvent::Pause
                };
                let _ = events().send(action);
            }
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_cannot_bind_two_actions_to_the_same_key() {
        let settings = recorder_core::AppSettings {
            hotkey: "Control+Shift+KeyR".into(),
            stop_hotkey: "Shift+Ctrl+R".into(),
            ..Default::default()
        };
        assert!(Shell::parse_keys(&settings).is_err());
    }

    #[test]
    fn physical_codes_from_the_picker_round_trip_through_native_hotkeys() {
        for code in [
            "KeyR",
            "Digit2",
            "F24",
            "PrintScreen",
            "Pause",
            "Space",
            "ArrowLeft",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "Insert",
            "Delete",
            "Backspace",
            "Numpad2",
        ] {
            let key: HotKey = format!("Control+Shift+{code}").parse().unwrap();
            assert_eq!(key, key.into_string().parse().unwrap());
        }
    }
}
