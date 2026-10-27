use serde::Serialize;
#[cfg(any(windows, test))]
use std::path::Path;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
pub struct LoginStatus {
    pub registered: bool,
    pub current_executable: bool,
}

pub struct LoginItem {
    executable: PathBuf,
    #[cfg(windows)]
    key: String,
    #[cfg(target_os = "macos")]
    path: PathBuf,
}

impl LoginItem {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            executable: std::env::current_exe()?,
            #[cfg(windows)]
            key: r"Software\Microsoft\Windows\CurrentVersion\Run".into(),
            #[cfg(target_os = "macos")]
            path: directories::BaseDirs::new()
                .ok_or_else(|| anyhow::anyhow!("Home directory not found"))?
                .home_dir()
                .join("Library/LaunchAgents/dev.screenrecorder.desktop.plist"),
        })
    }

    pub fn status(&self) -> anyhow::Result<LoginStatus> {
        let snapshot = self.snapshot()?;
        Ok(LoginStatus {
            registered: snapshot.is_some(),
            current_executable: self.matches(&snapshot)?,
        })
    }
}

#[cfg(windows)]
pub type Snapshot = Option<winreg::RegValue<'static>>;
#[cfg(not(windows))]
pub type Snapshot = Option<Vec<u8>>;

#[cfg(windows)]
impl LoginItem {
    fn command(&self) -> anyhow::Result<String> {
        windows_command(&self.executable)
    }

    pub fn snapshot(&self) -> anyhow::Result<Snapshot> {
        use std::io::ErrorKind;
        let key =
            match winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey(&self.key) {
                Ok(key) => key,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
        match key.get_raw_value("ScreenRecorder") {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn matches(&self, snapshot: &Snapshot) -> anyhow::Result<bool> {
        use winreg::types::FromRegValue;
        let Ok(command) = self.command() else {
            return Ok(false);
        };
        Ok(snapshot
            .as_ref()
            .and_then(|value| String::from_reg_value(value).ok())
            .as_deref()
            == Some(&command))
    }

    pub fn set(&self, enabled: bool) -> anyhow::Result<()> {
        use winreg::types::ToRegValue;
        if enabled {
            self.restore(&Some(self.command()?.to_reg_value()))
        } else {
            self.restore(&None)
        }
    }

    pub fn restore(&self, snapshot: &Option<winreg::RegValue<'_>>) -> anyhow::Result<()> {
        use std::io::ErrorKind;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        let parent = winreg::RegKey::predef(HKEY_CURRENT_USER);
        if let Some(value) = snapshot {
            let (key, _) = parent.create_subkey_with_flags(&self.key, KEY_SET_VALUE)?;
            key.set_raw_value("ScreenRecorder", value)?;
        } else {
            let key = match parent.open_subkey_with_flags(&self.key, KEY_SET_VALUE) {
                Ok(key) => key,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.into()),
            };
            if let Err(error) = key.delete_value("ScreenRecorder")
                && error.kind() != ErrorKind::NotFound
            {
                return Err(error.into());
            }
        }
        Ok(())
    }
}

#[cfg(any(windows, test))]
fn windows_command(executable: &Path) -> anyhow::Result<String> {
    let path = executable
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("The application path is not valid Unicode"))?;
    anyhow::ensure!(
        !path.contains(['"', '\0', '\n', '\r']),
        "The application path contains an invalid character"
    );
    let command = format!("\"{path}\" --background");
    anyhow::ensure!(
        command.encode_utf16().count() <= 260,
        "The application path is too long for Windows launch at login. Move the app to a shorter path."
    );
    Ok(command)
}

#[cfg(target_os = "macos")]
impl LoginItem {
    fn contents(&self) -> anyhow::Result<Vec<u8>> {
        let mut values = plist::Dictionary::new();
        values.insert("Label".into(), "dev.screenrecorder.desktop".into());
        values.insert(
            "ProgramArguments".into(),
            plist::Value::Array(vec![
                self.executable
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("The application path is not valid Unicode"))?
                    .into(),
                "--background".into(),
            ]),
        );
        values.insert("RunAtLoad".into(), true.into());
        let mut bytes = Vec::new();
        plist::to_writer_xml(&mut bytes, &values)?;
        Ok(bytes)
    }

    pub fn snapshot(&self) -> anyhow::Result<Snapshot> {
        match std::fs::read(&self.path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn matches(&self, snapshot: &Snapshot) -> anyhow::Result<bool> {
        let Some(bytes) = snapshot else {
            return Ok(false);
        };
        let Ok(plist::Value::Dictionary(values)) =
            plist::Value::from_reader(std::io::Cursor::new(bytes))
        else {
            return Ok(false);
        };
        Ok(values.get("ProgramArguments")
            == Some(&plist::Value::Array(vec![
                self.executable
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("The application path is not valid Unicode"))?
                    .into(),
                "--background".into(),
            ]))
            && values.get("RunAtLoad").and_then(plist::Value::as_boolean) == Some(true))
    }

    pub fn set(&self, enabled: bool) -> anyhow::Result<()> {
        self.restore(&if enabled {
            Some(self.contents()?)
        } else {
            None
        })
    }

    pub fn restore(&self, snapshot: &Snapshot) -> anyhow::Result<()> {
        use std::io::Write;
        if let Some(bytes) = snapshot {
            let parent = self
                .path
                .parent()
                .ok_or_else(|| anyhow::anyhow!("Launch agent folder not found"))?;
            std::fs::create_dir_all(parent)?;
            let mut file = tempfile::NamedTempFile::new_in(parent)?;
            file.write_all(bytes)?;
            file.as_file().sync_all()?;
            file.persist(&self.path)?;
        } else if let Err(error) = std::fs::remove_file(&self.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.into());
        }
        Ok(())
    }
}

pub fn show_on_launch(background: bool, start_in_tray: bool, needs_attention: bool) -> bool {
    needs_attention || (!background && !start_in_tray)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_launch_never_hides_errors_first_run_open_document_or_recovery() {
        for background in [true, false] {
            for tray in [true, false] {
                assert!(show_on_launch(background, tray, true));
                assert_eq!(
                    show_on_launch(background, tray, false),
                    !background && !tray
                );
            }
        }
    }

    #[test]
    fn windows_login_command_handles_spaces_unicode_and_rejects_unlaunchable_paths() {
        assert_eq!(
            windows_command(Path::new("C:/Apps/Запись экрана/Recorder.exe")).unwrap(),
            "\"C:/Apps/Запись экрана/Recorder.exe\" --background"
        );
        assert!(windows_command(Path::new("C:/bad\"name.exe")).is_err());
        assert!(windows_command(Path::new(&format!("C:/{}.exe", "a".repeat(260)))).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn login_registration_can_be_disabled_twice_and_exactly_restored() {
        use winreg::{RegKey, enums::HKEY_CURRENT_USER, types::ToRegValue};
        let key = format!(
            "Software\\ScreenRecorderTests\\{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let item = LoginItem {
            executable: PathBuf::from("C:/Apps/Запись экрана/Recorder.exe"),
            key: key.clone(),
        };
        item.set(false).unwrap();
        item.set(false).unwrap();
        assert!(!item.status().unwrap().registered);
        let long = LoginItem {
            executable: PathBuf::from(format!("C:/{}.exe", "a".repeat(260))),
            key: key.clone(),
        };
        assert!(!long.status().unwrap().registered);
        long.set(false).unwrap();
        assert!(long.set(true).is_err());
        item.set(true).unwrap();
        assert!(item.status().unwrap().current_executable);
        let original = Some("\"C:/Old folder/Recorder.exe\" --background".to_reg_value());
        item.restore(&original).unwrap();
        assert!(item.status().unwrap().registered);
        assert!(!item.status().unwrap().current_executable);
        let snapshot = item.snapshot().unwrap();
        item.set(true).unwrap();
        item.restore(&snapshot).unwrap();
        assert!(item.snapshot().unwrap() == original);
        item.set(false).unwrap();
        item.set(false).unwrap();
        assert!(!item.status().unwrap().registered);
        RegKey::predef(HKEY_CURRENT_USER)
            .delete_subkey(&key)
            .unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_agent_handles_xml_paths_atomic_replacement_removal_and_rollback() {
        let folder = tempfile::tempdir().unwrap();
        let item = LoginItem {
            executable: PathBuf::from(
                "/Applications/Запись & <Screen>.app/Contents/MacOS/Screen Recorder",
            ),
            path: folder.path().join("agents/recorder.plist"),
        };
        item.set(false).unwrap();
        item.set(false).unwrap();
        item.set(true).unwrap();
        assert!(item.status().unwrap().current_executable);
        let snapshot = item.snapshot().unwrap();
        let moved = LoginItem {
            executable: PathBuf::from("/Applications/Moved.app/Contents/MacOS/Screen Recorder"),
            path: item.path.clone(),
        };
        assert!(!moved.status().unwrap().current_executable);
        moved.set(true).unwrap();
        assert!(moved.status().unwrap().current_executable);
        item.restore(&snapshot).unwrap();
        assert!(item.status().unwrap().current_executable);
        item.set(false).unwrap();
        item.set(false).unwrap();
        assert!(!item.status().unwrap().registered);
        assert_eq!(
            std::fs::read_dir(item.path.parent().unwrap())
                .unwrap()
                .count(),
            0
        );
    }
}
