package io.github.triptu.notes.recents

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDateTime

class RecentsFeedTest {
    private val now = LocalDateTime.of(2026, 10, 27, 21, 0)

    @Test
    fun `rows say how long ago today, and the time of day under a date heading`() {
        assertEquals("now", RecentsFeedBuilder.relativeTime(now, now))
        assertEquals("24m", RecentsFeedBuilder.relativeTime(now.minusMinutes(24), now))
        assertEquals("2h", RecentsFeedBuilder.relativeTime(now.minusHours(2), now))
        assertEquals("18:20", RecentsFeedBuilder.relativeTime(LocalDateTime.of(2026, 10, 26, 18, 20), now))
        assertEquals("09:05", RecentsFeedBuilder.relativeTime(LocalDateTime.of(2026, 9, 2, 9, 5), now))
    }
}
