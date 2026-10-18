use std::io::{self, BufRead, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use std::{process, thread};

use serde::{Deserialize, Serialize};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition,
    PlatformConfig, SeekDirection,
};

#[derive(Deserialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum State {
    Playing,
    Paused,
    Stopped,
}

#[derive(Deserialize, PartialEq, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Track {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    artwork_url: Option<String>,
    duration_ms: Option<f64>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Update {
    state: State,
    #[serde(default)]
    position_ms: f64,
    #[serde(flatten)]
    track: Track,
}

#[derive(Serialize)]
#[serde(tag = "event", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Event {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    Seek { position_ms: f64 },
    SeekBy { offset_ms: f64 },
}

fn event_of(event: MediaControlEvent) -> Option<Event> {
    match event {
        MediaControlEvent::Play => Some(Event::Play),
        // Dyad has no stopped state that a user can choose
        MediaControlEvent::Pause | MediaControlEvent::Stop => Some(Event::Pause),
        MediaControlEvent::Toggle => Some(Event::Toggle),
        MediaControlEvent::Next => Some(Event::Next),
        MediaControlEvent::Previous => Some(Event::Previous),
        MediaControlEvent::SetPosition(MediaPosition(position)) => Some(Event::Seek {
            position_ms: position.as_secs_f64() * 1000.0,
        }),
        MediaControlEvent::SeekBy(direction, offset) => {
            let offset_ms = offset.as_secs_f64() * 1000.0;
            Some(Event::SeekBy {
                offset_ms: if direction == SeekDirection::Forward { offset_ms } else { -offset_ms },
            })
        }
        _ => None,
    }
}

fn seconds(ms: f64) -> Duration {
    Duration::from_secs_f64(ms.max(0.0) / 1000.0)
}

fn apply(controls: &mut MediaControls, shown: &mut Option<Track>, update: Update) {
    if update.state == State::Stopped {
        *shown = None;
        let _ = controls.set_playback(MediaPlayback::Stopped);
        return;
    }

    // Each new metadata loads the artwork again
    if shown.as_ref() != Some(&update.track) {
        let track = &update.track;
        let _ = controls.set_metadata(MediaMetadata {
            title: track.title.as_deref(),
            artist: track.artist.as_deref(),
            album: track.album.as_deref(),
            cover_url: track.artwork_url.as_deref(),
            duration: track.duration_ms.map(seconds),
        });
        *shown = Some(update.track);
    }

    let progress = Some(MediaPosition(seconds(update.position_ms)));
    let _ = controls.set_playback(if update.state == State::Playing {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    });
}

// souvlaki 0.8.3 does not advance the MPRIS `Position`, so the helper sets it again
#[cfg(target_os = "linux")]
const REFRESH: Duration = Duration::from_secs(1);
#[cfg(not(target_os = "linux"))]
const REFRESH: Duration = Duration::MAX;

fn main() {
    let config =
        PlatformConfig { display_name: "Dyad", dbus_name: "dyad", hwnd: platform::window() };
    let mut controls = MediaControls::new(config).expect("cannot create the media controls");
    controls
        .attach(|event| {
            if let Some(event) = event_of(event) {
                let line = serde_json::to_string(&event).expect("an event is valid JSON");
                let _ = writeln!(io::stdout().lock(), "{line}");
            }
        })
        .expect("cannot attach the media controls");

    // The helper must not outlive the client, so it exits when its input closes
    let (sender, updates) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            match serde_json::from_str::<Update>(&line) {
                Ok(update) => sender.send((update, Instant::now())).expect("the receiver lives"),
                Err(error) => eprintln!("invalid update: {error}"),
            }
        }
        process::exit(0);
    });

    thread::spawn(move || {
        let mut shown = None;
        let mut last: Option<(Update, Instant)> = None;
        loop {
            match updates.recv_timeout(REFRESH) {
                Ok(received) => last = Some(received),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            let Some((update, at)) = &last else { continue };
            let mut update = update.clone();
            if update.state == State::Playing {
                update.position_ms += at.elapsed().as_secs_f64() * 1000.0;
            }
            platform::on_main(|| apply(&mut controls, &mut shown, update));
        }
    });

    platform::run();
}

#[cfg(target_os = "macos")]
mod platform {
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRunLoopRun();
    }

    pub fn window() -> Option<*mut std::ffi::c_void> {
        None
    }

    pub fn on_main(work: impl FnOnce() + Send) {
        dispatch::Queue::main().exec_sync(work);
    }

    // MediaPlayer sends the remote commands to the main queue
    pub fn run() -> ! {
        unsafe { CFRunLoopRun() };
        unreachable!("the main run loop has no sources that can stop it")
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, RegisterClassW,
        WINDOW_STYLE, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    use windows::w;

    extern "system" fn procedure(window: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        unsafe { DefWindowProcW(window, message, w, l) }
    }

    // SMTC rejects a message-only window, so this is a top-level window that is never shown
    pub fn window() -> Option<*mut std::ffi::c_void> {
        unsafe {
            let instance = GetModuleHandleW(None).ok()?;
            let class = WNDCLASSW {
                lpfnWndProc: Some(procedure),
                hInstance: instance,
                lpszClassName: w!("DyadMediaControls"),
                ..Default::default()
            };
            RegisterClassW(&class);
            let window = CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                w!("DyadMediaControls"),
                w!("Dyad"),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                HWND::default(),
                None,
                instance,
                None,
            );
            (window.0 != 0).then_some(window.0 as _)
        }
    }

    pub fn on_main(work: impl FnOnce() + Send) {
        work();
    }

    // The window gets its messages on the thread that created it
    pub fn run() -> ! {
        let mut message = MSG::default();
        while unsafe { GetMessageW(&mut message, HWND::default(), 0, 0) }.as_bool() {
            unsafe { DispatchMessageW(&message) };
        }
        std::process::exit(0)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    pub fn window() -> Option<*mut std::ffi::c_void> {
        None
    }

    pub fn on_main(work: impl FnOnce() + Send) {
        work();
    }

    pub fn run() -> ! {
        loop {
            std::thread::park();
        }
    }
}
