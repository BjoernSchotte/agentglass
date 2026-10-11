/* agentglass — give freed heap back to the system (scriptc's runtime allocates through libc malloc, which keeps freed
   pages): Linux glibc malloc_trim(0) releases free pages in every arena, macOS relieves the default zones. Elsewhere 0. */
#if defined(__linux__)
#include <features.h> /* defines __GLIBC__ (no libc header was included before this test) */
#endif
#if defined(__linux__) && defined(__GLIBC__)
#include <malloc.h>
int ag_trim(void) { return malloc_trim(0); }
#elif defined(__APPLE__)
#include <malloc/malloc.h>
int ag_trim(void) { return malloc_zone_pressure_relief(NULL, 0) > 0; }
#else
int ag_trim(void) { return 0; }
#endif
