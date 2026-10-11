//! Process bookkeeping for the desktop app: finds the processes a server started and ends them, so
//! that closing the window leaves nothing running.
//!
//! The server is started as the leader of its own process group (see `server.rs`), so everything it
//! starts stays in that group unless it leaves on purpose. Two things find them: the group itself,
//! and the children of every process already known to belong to the tree. The kernel does not hand
//! a group id out again while the group has members, so the group is found by the leader's pid, and
//! the sweep runs as soon as the server ends, while its members still hold that id. A process the
//! tree tracks is named by its pid and its start time together, so a pid reused by another process
//! is never signalled as if it were that process.

use std::collections::HashSet;
use std::fs;
use std::thread::sleep;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(100);

/// A process, as read from `/proc/<pid>/stat`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    /// The process group. A group leader's group is named by the leader's pid.
    pub pgrp: i32,
    /// Start time in clock ticks since boot. With the pid, it names one process for good.
    pub start: u64,
    /// Ended, but not yet reaped by its parent.
    pub zombie: bool,
}

/// Reads one `/proc/<pid>/stat` line. The command name may hold spaces and parentheses, so the
/// other fields are read after its last closing parenthesis.
pub fn parse_stat(text: &str) -> Option<Proc> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let pid = text[..open].trim().parse().ok()?;
    let fields: Vec<&str> = text[close + 1..].split_whitespace().collect();
    // stat(5) numbers its fields from 1 and the state is field 3, so field n is fields[n - 3].
    let state = *fields.first()?;
    Some(Proc {
        pid,
        ppid: fields.get(1)?.parse().ok()?,
        pgrp: fields.get(2)?.parse().ok()?,
        start: fields.get(19)?.parse().ok()?,
        zombie: matches!(state, "Z" | "X"),
    })
}

/// Every process on the system right now.
pub fn scan() -> Vec<Proc> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .bytes()
                .all(|b| b.is_ascii_digit())
        })
        .filter_map(|entry| fs::read_to_string(entry.path().join("stat")).ok())
        .filter_map(|text| parse_stat(&text))
        .collect()
}

fn read_proc(pid: i32) -> Option<Proc> {
    parse_stat(&fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// The identity of the process with this pid, if it is running now.
pub fn identify(pid: u32) -> Option<Proc> {
    read_proc(pid as i32).filter(|process| !process.zombie)
}

/// Whether this exact process (pid and start time) still runs. An ended process does not count,
/// even before its parent reaps it.
pub fn is_running(process: Proc) -> bool {
    read_proc(process.pid).is_some_and(|now| now.start == process.start && !now.zombie)
}

/// Adds to `tracked` every process of the tree of `leader` as it is in `all`: the members of the
/// leader's process group, and every process started by one that is still running. Processes that
/// already ended stay recorded, so a later check still knows them.
fn track(all: &[Proc], leader: Proc, tracked: &mut Vec<Proc>) {
    let running_in = |process: &Proc| {
        all.iter()
            .any(|now| now.pid == process.pid && now.start == process.start && !now.zombie)
    };
    let mut members: HashSet<i32> = tracked
        .iter()
        .filter(|process| running_in(process))
        .map(|process| process.pid)
        .collect();
    if running_in(&leader) {
        members.insert(leader.pid);
    }
    let mut grew = true;
    while grew {
        grew = false;
        for process in all.iter().filter(|process| !process.zombie) {
            if !members.contains(&process.pid)
                && ((process.pgrp == leader.pid && process.start >= leader.start)
                    || members.contains(&process.ppid))
            {
                members.insert(process.pid);
                grew = true;
            }
        }
    }
    for process in all
        .iter()
        .filter(|process| !process.zombie && members.contains(&process.pid))
    {
        let known = tracked
            .iter()
            .any(|t| t.pid == process.pid && t.start == process.start);
        if !known {
            tracked.push(*process);
        }
    }
}

/// Refreshes the tree and returns the tracked processes that still run.
fn running_now(leader: Proc, tracked: &mut Vec<Proc>) -> Vec<Proc> {
    let all = scan();
    track(&all, leader, tracked);
    tracked
        .iter()
        .copied()
        .filter(|process| {
            all.iter()
                .any(|now| now.pid == process.pid && now.start == process.start && !now.zombie)
        })
        .collect()
}

/// Polls the tree until nothing runs or `timeout` has passed. Returns what still runs.
fn wait_until_clear(leader: Proc, tracked: &mut Vec<Proc>, timeout: Duration) -> Vec<Proc> {
    let deadline = Instant::now() + timeout;
    loop {
        let running = running_now(leader, tracked);
        if running.is_empty() || Instant::now() >= deadline {
            return running;
        }
        sleep(POLL);
    }
}

fn signal(process: Proc, signal: i32) {
    if is_running(process) {
        // SAFETY: a plain kill(2). The pid was just checked to still be this exact process.
        unsafe { libc::kill(process.pid, signal) };
    }
}

/// Stops the tree of `leader`, the server. The server is asked to stop first, and the wait is for the
/// server only: it ends the omp processes it started itself, and a window waiting for the whole tree
/// would freeze while omp's own commands run down. Then what is still in the tree (omp's children, in
/// the server's group) gets SIGTERM at once, and SIGKILL after `kill_wait` more. A leader that has
/// already ended gets no grace. Returns the processes that still run at the end: empty when nothing
/// was left over.
pub fn stop_tree(leader: Proc, grace: Duration, kill_wait: Duration) -> Vec<Proc> {
    let mut tracked = vec![leader];
    // Record the whole tree before anything ends: once a parent is gone its children are orphans
    // and the parent links no longer lead back to the leader.
    running_now(leader, &mut tracked);
    let alive = is_running(leader);
    if alive {
        signal(leader, libc::SIGTERM);
    }
    let deadline = Instant::now() + if alive { grace } else { Duration::ZERO };
    while is_running(leader) && Instant::now() < deadline {
        sleep(POLL);
    }
    let still = running_now(leader, &mut tracked);
    for process in &still {
        signal(*process, libc::SIGTERM);
    }
    let still = wait_until_clear(leader, &mut tracked, kill_wait);
    for process in &still {
        signal(*process, libc::SIGKILL);
    }
    wait_until_clear(leader, &mut tracked, kill_wait)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};

    #[test]
    fn parses_fields_after_a_command_name_with_spaces_and_parentheses() {
        let line = "4242 (weird (name) x) S 17 4242 4242 0 -1 4194560 100 0 0 0 5 6 0 0 20 0 1 0 987654 1000 200";
        assert_eq!(
            parse_stat(line),
            Some(Proc {
                pid: 4242,
                ppid: 17,
                pgrp: 4242,
                start: 987_654,
                zombie: false,
            })
        );
    }

    /// A group is only the leader's when its members began after the leader: a process older than the
    /// leader that happens to carry the same group id is some other group's.
    #[test]
    fn a_group_member_older_than_the_leader_is_not_taken_for_its_group() {
        let leader = Proc {
            pid: 500,
            ppid: 1,
            pgrp: 500,
            start: 2000,
            zombie: true,
        };
        let older = Proc {
            pid: 501,
            ppid: 1,
            pgrp: 500,
            start: 1000,
            zombie: false,
        };
        let newer = Proc {
            pid: 502,
            ppid: 1,
            pgrp: 500,
            start: 3000,
            zombie: false,
        };
        let all = vec![leader, older, newer];
        let mut tracked = vec![leader];
        track(&all, leader, &mut tracked);
        assert!(tracked.iter().any(|process| process.pid == 502));
        assert!(!tracked.iter().any(|process| process.pid == 501));
    }

    #[test]
    fn a_zombie_is_marked_and_a_bad_line_is_rejected() {
        let zombie = parse_stat("7 (sh) Z 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 55 0 0").unwrap();
        assert!(zombie.zombie);
        assert_eq!(parse_stat("not a stat line"), None);
        assert_eq!(parse_stat("7 (sh) S 1"), None);
    }

    #[test]
    fn this_process_is_found_and_running() {
        let me = read_proc(std::process::id() as i32).expect("own stat readable");
        assert!(is_running(me));
        assert!(scan().iter().any(|p| p.pid == me.pid));
    }

    /// Starts `script` with `sh -c` as the leader of its own process group.
    fn spawn_group(script: &str) -> (Child, Proc) {
        let child = Command::new("sh")
            .args(["-c", script])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("sh starts");
        let leader = read_proc(child.id() as i32).expect("leader stat readable");
        (child, leader)
    }

    /// The pid the script printed first: its background child.
    fn first_pid(child: &mut Child) -> i32 {
        let mut line = String::new();
        BufReader::new(child.stdout.as_mut().expect("piped stdout"))
            .read_line(&mut line)
            .expect("a line");
        line.trim().parse().expect("the script printed a pid")
    }

    #[test]
    fn stopping_the_tree_ends_the_leader_and_its_background_children() {
        let (mut child, leader) = spawn_group("sleep 120 & sleep 120 & wait");
        // Give the shell a moment to start its two sleeps.
        sleep(Duration::from_millis(300));
        let survivors = stop_tree(leader, Duration::from_secs(1), Duration::from_secs(1));
        assert!(survivors.is_empty(), "left over: {survivors:?}");
        let _ = child.wait();
        assert!(!scan().iter().any(|p| p.pgrp == leader.pid && !p.zombie));
    }

    #[test]
    fn stopping_the_tree_also_ends_a_child_that_left_the_group() {
        // `setsid` moves the sleep into a session and group of its own. While the leader lives the
        // sleep is still its child, so the tree check finds it; it is ended after the leader too.
        let (mut child, leader) = spawn_group("setsid sleep 120 >/dev/null 2>&1 & echo $!; wait");
        let escapee_pid = first_pid(&mut child);
        sleep(Duration::from_millis(300));
        let escapee = read_proc(escapee_pid).expect("the escapee runs");
        assert_ne!(escapee.pgrp, leader.pid, "the escapee left the group");
        let survivors = stop_tree(leader, Duration::from_secs(1), Duration::from_secs(1));
        assert!(survivors.is_empty(), "left over: {survivors:?}");
        let _ = child.wait();
        assert!(!is_running(escapee));
    }

    #[test]
    fn a_leader_that_ended_still_has_its_group_ended_at_once() {
        // The shell exits and leaves its background sleep running in the same group, as a server
        // that crashed would leave its omp processes behind.
        let (mut child, leader) = spawn_group("sleep 120 >/dev/null 2>&1 & echo $!; exit 0");
        let orphan = read_proc(first_pid(&mut child)).expect("the orphan runs");
        let _ = child.wait();
        let started = Instant::now();
        let survivors = stop_tree(leader, Duration::from_secs(5), Duration::from_secs(1));
        assert!(survivors.is_empty(), "left over: {survivors:?}");
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "the orphan waited out the grace period"
        );
        assert!(!is_running(orphan));
    }
}
