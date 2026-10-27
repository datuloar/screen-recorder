use recorder_core::Language;

pub fn system_language() -> &'static str {
    static SYSTEM: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SYSTEM.get_or_init(detect)
}

pub fn text(preference: Language, english: &'static str, russian: &'static str) -> &'static str {
    if preference.resolve(system_language()) == "ru" {
        russian
    } else {
        english
    }
}

#[cfg(windows)]
fn detect() -> String {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetUserDefaultUILanguage() -> u16;
    }
    if unsafe { GetUserDefaultUILanguage() } & 0x03ff == 0x19 {
        "ru"
    } else {
        "en"
    }
    .into()
}

#[cfg(target_os = "macos")]
fn detect() -> String {
    use std::ffi::{c_char, c_void};
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFLocaleCopyPreferredLanguages() -> *const c_void;
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFStringGetCString(
            string: *const c_void,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(value: *const c_void);
    }
    let mut locale = String::from("en");
    unsafe {
        let languages = CFLocaleCopyPreferredLanguages();
        if !languages.is_null() {
            if CFArrayGetCount(languages) > 0 {
                let first = CFArrayGetValueAtIndex(languages, 0);
                let mut buffer = [0u8; 128];
                if !first.is_null()
                    && CFStringGetCString(
                        first,
                        buffer.as_mut_ptr().cast(),
                        buffer.len() as isize,
                        0x0800_0100,
                    ) != 0
                {
                    let end = buffer
                        .iter()
                        .position(|&byte| byte == 0)
                        .unwrap_or(buffer.len());
                    if let Ok(value) = std::str::from_utf8(&buffer[..end]) {
                        locale = value.into();
                    }
                }
            }
            CFRelease(languages);
        }
    }
    locale
}

#[cfg(not(any(windows, target_os = "macos")))]
fn detect() -> String {
    std::env::var("LC_MESSAGES")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_else(|_| "en".into())
}
