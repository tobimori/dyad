use std::io::{self, BufRead, Write};
use std::{process, thread, time::Duration};

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

#[derive(Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
struct Track {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    artwork_url: Option<String>,
    duration_ms: Option<f64>,
}

#[derive(Deserialize)]
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

fn main() {
    let config = PlatformConfig { display_name: "Dyad", dbus_name: "dyad", hwnd: None };
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
    thread::spawn(move || {
        let mut shown = None;
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            match serde_json::from_str::<Update>(&line) {
                Ok(update) => platform::on_main(|| apply(&mut controls, &mut shown, update)),
                Err(error) => eprintln!("invalid update: {error}"),
            }
        }
        process::exit(0);
    });

    platform::run();
}

#[cfg(target_os = "macos")]
mod platform {
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRunLoopRun();
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

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn on_main(work: impl FnOnce() + Send) {
        work();
    }

    pub fn run() -> ! {
        loop {
            std::thread::park();
        }
    }
}
