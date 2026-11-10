package main

import (
	"heliosgen/internal/bridgecli"
	"os"
)

func main() { os.Exit(bridgecli.Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }
