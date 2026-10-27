use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FragmentPrefix {
    pub bytes: u64,
    pub discarded_bytes: u64,
    pub fragments: u64,
}

pub fn complete_fragment_prefix(path: &Path) -> anyhow::Result<FragmentPrefix> {
    let mut file = File::open(path)?;
    scan(&mut file)
}

fn scan(file: &mut (impl Read + Seek)) -> anyhow::Result<FragmentPrefix> {
    let length = file.seek(SeekFrom::End(0))?;
    let mut offset = 0u64;
    let mut prefix = 0;
    let mut fragments = 0;
    let mut moov = false;
    let mut pending = false;
    while offset.checked_add(8).is_some_and(|end| end <= length) {
        file.seek(SeekFrom::Start(offset))?;
        let mut header = [0; 8];
        file.read_exact(&mut header)?;
        let size = u32::from_be_bytes(header[..4].try_into().unwrap());
        let (size, header_size) = if size == 1 {
            let mut extended = [0; 8];
            if file.read_exact(&mut extended).is_err() {
                break;
            }
            (u64::from_be_bytes(extended), 16)
        } else {
            (size as u64, 8)
        };
        // A zero-sized mdat extends to EOF and cannot prove the last fragment is complete.
        if size < header_size {
            break;
        }
        let Some(end) = offset.checked_add(size).filter(|end| *end <= length) else {
            break;
        };
        match &header[4..8] {
            b"moov" => moov = true,
            b"moof" => pending = moov,
            b"mdat" if pending => {
                prefix = end;
                fragments += 1;
                pending = false;
            }
            _ => {}
        }
        offset = end;
    }
    anyhow::ensure!(
        fragments > 0,
        "The recording has no complete MP4 fragments to recover. The source file is unchanged."
    );
    Ok(FragmentPrefix {
        bytes: prefix,
        discarded_bytes: length - prefix,
        fragments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn atom(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut result = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        result.extend(kind);
        result.extend(payload);
        result
    }
    #[test]
    fn partial_media_data_never_enters_a_recovered_prefix() {
        let mut bytes = atom(b"ftyp", b"test");
        bytes.extend(atom(b"moov", b"init"));
        bytes.extend(atom(b"moof", b"one"));
        bytes.extend(atom(b"mdat", b"complete"));
        let boundary = bytes.len() as u64;
        bytes.extend(atom(b"moof", b"two"));
        let tail = atom(b"mdat", b"partial");
        bytes.extend(&tail[..tail.len() - 3]);
        let length = bytes.len() as u64;
        assert_eq!(
            scan(&mut Cursor::new(bytes)).unwrap(),
            FragmentPrefix {
                bytes: boundary,
                discarded_bytes: length - boundary,
                fragments: 1
            }
        );
    }
    #[test]
    fn initialization_without_a_complete_first_fragment_is_not_a_video() {
        let mut bytes = atom(b"moov", b"init");
        bytes.extend(atom(b"moof", b"one"));
        assert!(scan(&mut Cursor::new(bytes.as_slice())).is_err());
        bytes.extend([0xff; 16]);
        assert!(scan(&mut Cursor::new(bytes)).is_err());
    }
}
