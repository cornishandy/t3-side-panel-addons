/* Print one process's start time and executable.
 * stdout: PID \t START_US \t PRECISE \t EXE \n
 * START_US is microseconds since the Unix epoch. PRECISE is 1 only when
 * proc_pidinfo returned a start time. A missing process prints PRECISE 0
 * and an empty executable, and still exits 0.
 */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libproc.h>
#include <sys/proc_info.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end = NULL;
  long pidLong = strtol(argv[1], &end, 10);
  if (!end || *end != '\0' || pidLong <= 0 || pidLong > 0x7fffffffL) return 2;
  int pid = (int)pidLong;

  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  int got = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  unsigned long long startUs = 0;
  int precise = 0;
  if (got == (int)sizeof(info)) {
    startUs = (unsigned long long)info.pbi_start_tvsec * 1000000ULL
      + (unsigned long long)info.pbi_start_tvusec;
    if (startUs > 0) precise = 1;
  }

  char path[PROC_PIDPATHINFO_MAXSIZE];
  memset(path, 0, sizeof(path));
  int pathLen = proc_pidpath(pid, path, sizeof(path));
  if (pathLen <= 0) path[0] = '\0';

  printf("%d\t%llu\t%d\t%s\n", pid, startUs, precise, path);
  return 0;
}
