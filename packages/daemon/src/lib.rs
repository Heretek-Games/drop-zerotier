//! Join/leave a ZeroTier network through the local ZeroTier One service.
//!
//! The desktop does not embed a ZeroTier client, so room membership is applied
//! by invoking `zerotier-cli` (which talks to the platform service). Joining
//! typically requires administrator/root privileges; failures are surfaced to
//! the user with an actionable message rather than failing silently.
//!
//! After joining, the controller needs the local node id to authorize the
//! member, so `join_network` also reports this node's 10-hex address.

use std::process::Command;

/// Shown when no ZeroTier CLI can be found on the host.
pub const NOT_INSTALLED: &str =
    "ZeroTier is not installed. Install ZeroTier One and sign in to join multiplayer rooms.";

fn candidates() -> Vec<String> {
    #[allow(unused_mut)]
    let mut paths = vec!["zerotier-cli".to_string()];

    #[cfg(target_os = "linux")]
    {
        paths.push("/usr/sbin/zerotier-cli".to_string());
        paths.push("/usr/bin/zerotier-cli".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        paths.push("/Library/Application Support/ZeroTier/One/zerotier-cli".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        paths.push("C:\\ProgramData\\ZeroTier\\One\\zerotier-cli.bat".to_string());
    }

    paths
}

/// Join the given ZeroTier network (`zerotier-cli join <nwid>`).
///
/// Returns this node's 10-hex ZeroTier address, which the server needs to
/// authorize the member on the room's controller (`POST /rooms/:id/member`).
pub fn join_network(network_id: &str) -> Result<String, String> {
    if network_id.trim().is_empty() {
        return Err("missing ZeroTier network id".to_string());
    }
    run("join", network_id)?;
    node_id()
}

/// Leave the given ZeroTier network (`zerotier-cli leave <nwid>`).
pub fn leave_network(network_id: &str) -> Result<(), String> {
    run("leave", network_id)
}

/// Read this node's ZeroTier address from `zerotier-cli info`.
pub fn node_id() -> Result<String, String> {
    let output = run_capture(&["info"])?;
    parse_node_id(&output)
        .ok_or_else(|| "could not read the ZeroTier node id from `zerotier-cli info`".to_string())
}

/// Extract the 10-hex node address from `200 info <address> <version> <status>`.
fn parse_node_id(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|token| token.len() == 10 && token.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_string)
}

fn run(verb: &str, network_id: &str) -> Result<(), String> {
    if network_id.trim().is_empty() {
        return Err("missing ZeroTier network id".to_string());
    }

    for candidate in candidates() {
        match Command::new(&candidate).args([verb, network_id]).output() {
            Ok(output) if output.status.success() => return Ok(()),
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let message = if !stderr.is_empty() { stderr } else { stdout };
                // "already a member" is harmless for join.
                if message.to_lowercase().contains("already") {
                    return Ok(());
                }
                return Err(if message.is_empty() {
                    format!("zerotier-cli {verb} failed")
                } else {
                    message
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err.to_string()),
        }
    }

    Err(NOT_INSTALLED.to_string())
}

/// Run a `zerotier-cli` subcommand and return its stdout.
fn run_capture(args: &[&str]) -> Result<String, String> {
    for candidate in candidates() {
        match Command::new(&candidate).args(args).output() {
            Ok(output) if output.status.success() => {
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let message = if !stderr.is_empty() { stderr } else { stdout };
                return Err(if message.is_empty() {
                    format!("zerotier-cli {} failed", args.join(" "))
                } else {
                    message
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err.to_string()),
        }
    }

    Err(NOT_INSTALLED.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_network_id_is_rejected() {
        assert!(join_network("").is_err());
        assert!(leave_network("   ").is_err());
    }

    #[test]
    fn candidates_include_the_bare_command() {
        assert!(
            candidates()
                .iter()
                .any(|candidate| candidate == "zerotier-cli")
        );
    }

    #[test]
    fn parses_the_node_id_from_info_output() {
        assert_eq!(
            parse_node_id("200 info 8056c2e21c 1.12.2 ONLINE").as_deref(),
            Some("8056c2e21c")
        );
        // Trailing newline / extra spacing must not matter.
        assert_eq!(
            parse_node_id("200 info deadbeef01 1.14.0 ONLINE\n").as_deref(),
            Some("deadbeef01")
        );
        assert_eq!(parse_node_id("200 info not-a-node ONLINE"), None);
        assert_eq!(parse_node_id(""), None);
    }
}
