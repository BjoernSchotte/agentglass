// agentglass — a fake agent process for footprint and parity runs (scripts/fixture-agents.sh): started through
// symlinks named claude, codex or node, it holds children, an exec chain, an open file, streams a transcript line and
// burns cpu as told, until SIGTERM. POSIX C, builds on Linux and macOS: cc -O2 -Wall -Wextra -Werror
//   fake-agent [script…] [--children n] [--grandchild] [--open file] [--append file --every s] [--line text] [--busy pct]
// It leads its own process group: on SIGTERM it signals the group (children, sh, sleep) and exits 0.
// SPDX-License-Identifier: Apache-2.0
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stop = 0;
static void on_term(int sig) { (void)sig; stop = 1; }

static double now_s(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (double)t.tv_sec + (double)t.tv_nsec / 1e9; }
static void nap(double s) {
  if (s <= 0) return;
  struct timespec t; t.tv_sec = (time_t)s; t.tv_nsec = (long)((s - (double)t.tv_sec) * 1e9);
  nanosleep(&t, NULL); // EINTR on SIGTERM: the caller looks at stop
}
// a child that sleeps until its group is signalled
static void sleeper(void) { signal(SIGTERM, SIG_DFL); for (;;) pause(); }
// pct % of one core in 10 ms slices
static void burner(int pct) {
  signal(SIGTERM, SIG_DFL);
  double busy = 0.01 * pct / 100.0;
  for (;;) { double t0 = now_s(); while (now_s() - t0 < busy) { /* spin */ } nap(0.01 - busy); }
}

int main(int argc, char **argv) {
  int children = 0, grandchild = 0, busy = 0; double every = 0; const char *open_f = NULL, *append_f = NULL, *line = "{}";
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i]; const char *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (!strcmp(a, "--grandchild")) grandchild = 1;
    else if (a[0] == '-' && a[1] == '-' && !v) { fprintf(stderr, "fake-agent: %s needs a value\n", a); return 2; }
    else if (!strcmp(a, "--children")) { children = atoi(v); i++; }
    else if (!strcmp(a, "--open")) { open_f = v; i++; }
    else if (!strcmp(a, "--append")) { append_f = v; i++; }
    else if (!strcmp(a, "--every")) { every = atof(v); i++; }
    else if (!strcmp(a, "--line")) { line = v; i++; }
    else if (!strcmp(a, "--busy")) { busy = atoi(v); i++; }
    else if (a[0] == '-') { fprintf(stderr, "fake-agent: unknown option %s\n", a); return 2; }
    // anything else: the script a node-named copy "runs" (gemini.js)
  }
  setpgid(0, 0);
  struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_handler = on_term; sigaction(SIGTERM, &sa, NULL); // no SA_RESTART: sleeps end
  int held = -1; if (open_f) { held = open(open_f, O_RDONLY); if (held < 0) { perror(open_f); return 1; } }
  for (int i = 0; i < children; i++) if (fork() == 0) sleeper();
  if (grandchild && fork() == 0) { signal(SIGTERM, SIG_DFL); execl("/bin/sh", "sh", "-c", "sleep 3600; :", (char *)NULL); _exit(127); } // "; :" keeps sh: an exec chain sh → sleep
  if (busy > 0 && fork() == 0) burner(busy > 100 ? 100 : busy);
  double next = now_s() + every;
  while (!stop) {
    if (append_f && every > 0) {
      double d = next - now_s();
      if (d > 0) { nap(d); continue; }
      int fd = open(append_f, O_WRONLY | O_APPEND | O_CREAT, 0644);
      if (fd >= 0) { size_t l = strlen(line); if (write(fd, line, l) != (ssize_t)l || write(fd, "\n", 1) != 1) perror(append_f); close(fd); }
      next += every;
    } else pause();
  }
  signal(SIGTERM, SIG_IGN); kill(0, SIGTERM); // the whole group: children, the sh and its sleep
  while (wait(NULL) > 0) { /* reap */ }
  if (held >= 0) close(held);
  return 0;
}
