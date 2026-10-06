// agentglass — macOS process reads for src/platform/libproc.ts, bound through scriptc --ffi (ffi.json): the pid list,
// identity, cpu, rss, arguments, cwd and open files from libproc and sysctl, no ps or lsof child. Each function writes
// into (buf, n) and returns the bytes written, 0 = the pid is gone, -1 = it cannot be read, -k = buf too small (k bytes
// needed; the caller grows buf and calls again). macOS SDK only.
// SPDX-License-Identifier: Apache-2.0
#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <mach/mach_time.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/sysctl.h>

static int clamp(size_t k) { return k > INT_MAX ? INT_MAX : (int)k; }
static int gone_or_unreadable(void) { return errno == ESRCH ? 0 : -1; }

// proc_listallpids: the pids as int32 (native little-endian); returns the count. count * 4 >= n: the list may be cut,
// the caller grows buf and calls again
int ag_pids(uint8_t *buf, size_t n) {
  int c = proc_listallpids(buf, clamp(n));
  return c < 0 ? -1 : c;
}

// "ppid uid zombie startMs cpuMs rss tty\tcomm": identity from sysctl(KERN_PROC_PID), which answers for every uid (as
// ps reads it); cpu and resident bytes from proc_pid_rusage, which another user's process refuses (cpu -1, rss 0).
// rusage times are mach absolute-time units on arm64 (timebase 125/3), nanoseconds on Intel (1/1)
int ag_stat(int pid, uint8_t *buf, size_t n) {
  static mach_timebase_info_data_t tb;
  struct kinfo_proc kp; size_t len = sizeof kp;
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  if (sysctl(mib, 4, &kp, &len, NULL, 0) < 0) return gone_or_unreadable();
  if (len < sizeof kp || kp.kp_proc.p_pid != pid) return 0; // no such pid: an empty answer
  if (!tb.denom && mach_timebase_info(&tb) != KERN_SUCCESS) { tb.numer = 1; tb.denom = 1; }
  long long cpu = -1, rss = 0;
  struct rusage_info_v2 ri;
  if (proc_pid_rusage(pid, RUSAGE_INFO_V2, (rusage_info_t *)&ri) == 0) {
    cpu = (long long)((double)(ri.ri_user_time + ri.ri_system_time) * tb.numer / tb.denom / 1e6);
    rss = (long long)ri.ri_resident_size;
  }
  const char *tty = "??"; // no controlling terminal, as ps prints it
  if (kp.kp_eproc.e_tdev != NODEV) { const char *d = devname(kp.kp_eproc.e_tdev, S_IFCHR); if (d && *d) tty = d; }
  char comm[MAXCOMLEN + 1]; size_t k = 0;
  for (; k < MAXCOMLEN && kp.kp_proc.p_comm[k]; k++) { char ch = kp.kp_proc.p_comm[k]; comm[k] = ch == '\t' || ch == '\n' ? ' ' : ch; }
  comm[k] = 0;
  long long start = (long long)kp.kp_proc.p_starttime.tv_sec * 1000 + kp.kp_proc.p_starttime.tv_usec / 1000;
  int w = snprintf((char *)buf, n, "%d %u %d %lld %lld %lld %s\t%s", (int)kp.kp_eproc.e_ppid, (unsigned)kp.kp_eproc.e_ucred.cr_uid,
                   kp.kp_proc.p_stat == SZOMB ? 1 : 0, start, cpu, rss, tty, comm);
  if (w < 0) return -1;
  return (size_t)w >= n ? -(w + 1) : w; // snprintf needs room for its NUL
}

// KERN_PROCARGS2 is argc, the exec path, NUL padding, argv, then the environment: only argv is copied (never the
// environment), joined by spaces, control bytes as spaces (as ps args shows them). A result over n bytes is cut at n and
// returns -(its full length)
int ag_args(int pid, uint8_t *buf, size_t n) {
  static int argmax = 0;
  if (!argmax) {
    int m[2] = { CTL_KERN, KERN_ARGMAX }; size_t l = sizeof argmax;
    if (sysctl(m, 2, &argmax, &l, NULL, 0) < 0 || argmax <= 0) argmax = 262144;
    if (argmax > 1 << 20) argmax = 1 << 20;
  }
  char *a = malloc((size_t)argmax); if (!a) return -1;
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid }; size_t len = (size_t)argmax;
  if (sysctl(mib, 3, a, &len, NULL, 0) < 0 || len < sizeof(int)) { free(a); return -1; } // another user's, or gone
  int argc; memcpy(&argc, a, sizeof argc);
  size_t p = sizeof argc, w = 0, need = 0;
  while (p < len && a[p]) p++; // the exec path
  while (p < len && !a[p]) p++; // its padding
  for (int i = 0; i < argc && p < len; i++, p++) {
    if (i) { if (w < n) buf[w++] = ' '; need++; }
    for (; p < len && a[p]; p++) { unsigned char ch = (unsigned char)a[p]; if (w < n) buf[w++] = ch < 32 || ch == 127 ? ' ' : ch; need++; }
  }
  free(a);
  return need > n ? -clamp(need) : (int)need;
}

static int put_path(uint8_t *buf, size_t n, const char *s) {
  size_t l = strnlen(s, MAXPATHLEN);
  if (l > n) return -clamp(l);
  memcpy(buf, s, l); return (int)l;
}

// the current directory
int ag_cwd(int pid, uint8_t *buf, size_t n) {
  struct proc_vnodepathinfo v;
  int r = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &v, sizeof v);
  if (r <= 0) return gone_or_unreadable();
  if ((size_t)r < sizeof v) return -1;
  return put_path(buf, n, v.pvi_cdir.vip_path);
}

// the paths of the open vnodes (files, dirs), NUL-terminated one after another
int ag_files(int pid, uint8_t *buf, size_t n) {
  int sz = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (sz <= 0) return gone_or_unreadable();
  struct proc_fdinfo *fds = malloc((size_t)sz); if (!fds) return -1;
  sz = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, sz);
  if (sz <= 0) { int e = gone_or_unreadable(); free(fds); return e; }
  size_t c = (size_t)sz / sizeof *fds, w = 0, need = 0;
  for (size_t i = 0; i < c; i++) {
    if (fds[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
    struct vnode_fdinfowithpath vi;
    if (proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDVNODEPATHINFO, &vi, sizeof vi) < (int)sizeof vi) continue; // closed meanwhile
    size_t l = strnlen(vi.pvip.vip_path, MAXPATHLEN); if (!l) continue;
    if (w + l + 1 <= n) { memcpy(buf + w, vi.pvip.vip_path, l); buf[w + l] = 0; w += l + 1; }
    need += l + 1;
  }
  free(fds);
  return need > n ? -clamp(need) : (int)w;
}
