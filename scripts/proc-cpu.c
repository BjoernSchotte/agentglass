// agentglass — cpu time of a macOS process for scripts/footprint.sh: "<self ms> <children ms>", children = the exited
// children it waited for (ps -S does not count them on macOS 14: V1 in specs/macos-footprint). rusage times are mach
// absolute-time units on arm64, nanoseconds on Intel: scaled by the timebase. cc -O2 -o proc-cpu proc-cpu.c
// SPDX-License-Identifier: Apache-2.0
#include <libproc.h>
#include <mach/kern_return.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int main(int argc, char **argv) {
  if (argc != 2) { fprintf(stderr, "usage: proc-cpu <pid>\n"); return 2; }
  struct rusage_info_v2 ri; mach_timebase_info_data_t tb;
  if (mach_timebase_info(&tb) != KERN_SUCCESS || !tb.denom) { tb.numer = 1; tb.denom = 1; }
  if (proc_pid_rusage(atoi(argv[1]), RUSAGE_INFO_V2, (rusage_info_t *)&ri) != 0) { perror("proc_pid_rusage"); return 1; }
  double k = (double)tb.numer / tb.denom / 1e6;
  printf("%.0f %.0f\n", (double)(ri.ri_user_time + ri.ri_system_time) * k, (double)(ri.ri_child_user_time + ri.ri_child_system_time) * k);
  return 0;
}
