package server

import "sync"

type concurrencyGate struct {
	mu      sync.Mutex
	queries map[string]int
	tails   map[string]int
	maxQ    int
	maxT    int
}

func newConcurrencyGate(maxQueries, maxTails int) *concurrencyGate {
	return &concurrencyGate{queries: map[string]int{}, tails: map[string]int{}, maxQ: maxQueries, maxT: maxTails}
}

func (g *concurrencyGate) acquire(subject string, tail bool) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if tail {
		if g.tails[subject] >= g.maxT {
			return false
		}
		g.tails[subject]++
		return true
	}
	if g.queries[subject] >= g.maxQ {
		return false
	}
	g.queries[subject]++
	return true
}

func (g *concurrencyGate) release(subject string, tail bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	target := g.queries
	if tail {
		target = g.tails
	}
	if target[subject] <= 1 {
		delete(target, subject)
		return
	}
	target[subject]--
}
