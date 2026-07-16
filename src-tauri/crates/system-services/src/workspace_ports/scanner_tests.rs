use super::*;

#[test]
fn parses_lsof_pcn_output() {
    let output = "\
p1234
cnode
n*:5173
p5678
cvite
n127.0.0.1:3000
";
    let ports = parse_lsof_listening_output(output);
    assert_eq!(ports.len(), 2);
    assert_eq!(ports[0].pid, Some(1234));
    assert_eq!(ports[0].process_name.as_deref(), Some("node"));
    assert_eq!(ports[0].port, 5173);
    assert_eq!(ports[1].port, 3000);
}

#[test]
fn parses_netstat_listening_rows() {
    let output = "\
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       5151
  TCP    127.0.0.1:5173         127.0.0.1:4000         ESTABLISHED     5151
";
    let ports = parse_netstat_listening_output(output);
    assert_eq!(ports.len(), 2);
    assert_eq!(ports[0].port, 3000);
    assert_eq!(ports[0].pid, Some(4242));
    assert_eq!(ports[1].port, 5173);
}

#[test]
fn parses_proc_net_tcp_listen_rows() {
    let content = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1388 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1389 00000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0
";
    let sockets = parse_proc_net_tcp(content);
    assert_eq!(sockets.len(), 1);
    assert_eq!(sockets[0].0, "127.0.0.1");
    assert_eq!(sockets[0].1, 5000);
    assert_eq!(sockets[0].2, 12345);
}

#[test]
fn detects_container_process_names() {
    let port = RawListeningPort {
        host: "0.0.0.0".to_string(),
        port: 8080,
        pid: Some(1),
        process_name: Some("com.docker.backend".to_string()),
        command_line: None,
        cwd: None,
    };
    assert!(is_container_process(&port));
}

#[cfg(unix)]
#[test]
fn run_command_times_out_when_child_produces_no_output() {
    let started = std::time::Instant::now();
    let error = run_command("sh", &["-c", "sleep 30"]).expect_err("should time out");

    assert!(error.is_timeout());
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}
