// go-runner — executes the native Go load / client-spoofing programs that the
// Askfor Test Runner UI generates.
//
// Two modes:
//   run one script now:   go-runner path/to/abc123.go
//   watch the shared dir: go-runner --watch /generated
//
// In watch mode it polls DIR for *.go, runs each one it hasn't run before with
// `go run <file>`, streams the output to stdout *and* to <name>.log next to the
// script, and drops a <name>.done marker (containing the exit code) so it isn't
// re-run. The Node service writes scripts there via "Send to go-runner"; the two
// services share only this directory.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"time"
)

const pollSeconds = 2

func runOne(script string) int {
	base := script[:len(script)-len(filepath.Ext(script))]
	logPath := base + ".log"
	donePath := base + ".done"
	stopPath := base + ".stop"
	_ = os.Remove(stopPath) // clear any stale marker from a previous run
	fmt.Printf("[go-runner] running %s -> %s\n", filepath.Base(script), filepath.Base(logPath))

	logFile, err := os.Create(logPath)
	if err != nil {
		fmt.Printf("[go-runner] cannot create %s: %v\n", logPath, err)
		_ = os.WriteFile(donePath, []byte("error: "+err.Error()), 0o644)
		return 1
	}
	defer logFile.Close()

	cmd := exec.Command("go", "run", filepath.Base(script))
	cmd.Dir = filepath.Dir(script)
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")

	out := io.MultiWriter(os.Stdout, logFile)
	cmd.Stdout = out
	cmd.Stderr = out

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(out, "[go-runner] start error: %v\n", err)
		_ = os.WriteFile(donePath, []byte("error: "+err.Error()), 0o644)
		return 1
	}

	// The UI's Stop button (via the node service) drops a <base>.stop file.
	stopped := make(chan struct{})
	go func() {
		t := time.NewTicker(500 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-stopped:
				return
			case <-t.C:
				if _, err := os.Stat(stopPath); err == nil {
					fmt.Fprintln(out, "[go-runner] stop requested — killing run")
					_ = cmd.Process.Kill()
					_ = os.Remove(stopPath)
					return
				}
			}
		}
	}()

	code := 0
	if err := cmd.Wait(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else {
			fmt.Fprintf(out, "[go-runner] exec error: %v\n", err)
			code = 1
		}
	}
	close(stopped)

	_ = os.WriteFile(donePath, []byte(strconv.Itoa(code)), 0o644)
	fmt.Printf("[go-runner] %s exited %d\n", filepath.Base(script), code)
	return code
}

func watch(dir string) {
	_ = os.MkdirAll(dir, 0o755)
	fmt.Printf("[go-runner] watching %s for *.go every %ds\n", dir, pollSeconds)
	for {
		matches, _ := filepath.Glob(filepath.Join(dir, "*.go"))
		sort.Strings(matches)
		for _, script := range matches {
			donePath := script[:len(script)-len(filepath.Ext(script))] + ".done"
			if _, err := os.Stat(donePath); err == nil {
				continue
			}
			func() {
				defer func() {
					if r := recover(); r != nil { // never let one bad script kill the watcher
						fmt.Printf("[go-runner] ERROR on %s: %v\n", filepath.Base(script), r)
						_ = os.WriteFile(donePath, []byte(fmt.Sprintf("error: %v", r)), 0o644)
					}
				}()
				runOne(script)
			}()
		}
		time.Sleep(pollSeconds * time.Second)
	}
}

func main() {
	watchDir := flag.String("watch", "", "watch DIR and run each new *.go")
	flag.Parse()

	if *watchDir != "" {
		watch(*watchDir)
		return
	}
	if flag.NArg() == 1 {
		os.Exit(runOne(flag.Arg(0)))
	}
	fmt.Fprintln(os.Stderr, "usage: go-runner <script.go> | go-runner --watch DIR")
	os.Exit(2)
}
