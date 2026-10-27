package io.github.triptu.notes.sync

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SyncSchedulerTest {
    private class Harness(val test: TestScope) {
        val backgroundScope get() = test.backgroundScope
        val runs = mutableListOf<Long>()
        var fail: Throwable? = null
        val scheduler = SyncScheduler(test.backgroundScope, run = {
            runs.add(test.testScheduler.currentTime)
            fail?.let { throw it }
        }, onError = {}, clock = { test.testScheduler.currentTime })

        fun at(time: Long) {
            test.advanceTimeBy(time - test.testScheduler.currentTime)
            test.runCurrent()
        }
    }

    @Test
    fun foregroundSyncsSoonThenEveryFiveMinutes() = runTest {
        val h = Harness(this)
        h.scheduler.foreground()
        h.at(1_000)
        h.at(301_000)
        h.at(601_000)
        assertEquals(listOf(1_000L, 301_000L, 601_000L), h.runs)
    }

    @Test
    fun editsWaitForAPauseButAtMostTwoMinutes() = runTest {
        val h = Harness(this)
        h.scheduler.foreground()
        h.at(1_000)
        // Typing every 20 s from t=10 s: the 30 s pause never comes, the 2 min cap does.
        for (t in 10_000L..200_000L step 20_000L) {
            h.at(t)
            h.scheduler.edited()
        }
        h.at(200_000)
        assertEquals(listOf(1_000L, 130_000L), h.runs)
        h.at(230_000)
        assertEquals(listOf(1_000L, 130_000L, 220_000L), h.runs)
    }

    @Test
    fun backgroundSendsWaitingEditsAndStopsTimers() = runTest {
        val h = Harness(this)
        h.scheduler.foreground()
        h.at(1_000)
        h.at(5_000)
        h.scheduler.edited()
        h.at(6_000)
        h.scheduler.background()
        h.at(6_000)
        h.at(2_000_000)
        assertEquals(listOf(1_000L, 6_000L), h.runs)
    }

    @Test
    fun failuresBackOffAndHonorRateLimitResets() = runTest {
        val h = Harness(this)
        h.fail = SyncError(SyncError.Kind.Offline, "offline")
        h.scheduler.foreground()
        h.at(1_000) // Fails: nothing before 6 s; the next periodic run is at 301 s.
        h.at(2_000)
        h.scheduler.edited() // Runs after the typing pause, at 32 s, and fails again: 10 s backoff.
        h.at(35_000)
        // Inside the backoff, but the user asked: it runs at once.
        h.fail = SyncError(SyncError.Kind.Offline, "rate limited", retryAt = 500_000)
        h.backgroundScope.launch { h.scheduler.now() }
        h.at(35_000)
        h.scheduler.edited() // Automatic runs wait for the rate-limit reset.
        h.at(499_000)
        assertEquals(listOf(1_000L, 32_000L, 35_000L), h.runs)
        h.fail = null
        h.at(500_000)
        assertEquals(listOf(1_000L, 32_000L, 35_000L, 500_000L), h.runs)
    }
}
