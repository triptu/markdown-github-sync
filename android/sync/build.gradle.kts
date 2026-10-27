import org.gradle.api.tasks.testing.logging.TestExceptionFormat

plugins {
    alias(libs.plugins.android.library)
}

// The sync engine is the plugin's TypeScript in plugin/src/git-sync, bundled
// with esbuild for QuickJS. Node must be on PATH (or pass -Pnode=/path/to/node).
val engineSources = rootProject.layout.projectDirectory.dir("../plugin/src")
val bundleScript = layout.projectDirectory.file("js/build.mjs")
val bundleDir = layout.buildDirectory.dir("generated/syncEngine")
val bundleFile = bundleDir.map { it.file("sync-engine.js") }
val nodeBinary = providers.gradleProperty("node").orElse("node")

android {
    namespace = "io.github.triptu.notes.sync"
    compileSdk = 36

    defaultConfig {
        minSdk = 31
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.all {
            it.systemProperty("syncEngineBundle", bundleFile.get().asFile.absolutePath)
            it.inputs.file(bundleFile)
            it.testLogging {
                events("passed", "skipped", "failed", "standard_out")
                exceptionFormat = TestExceptionFormat.FULL
            }
        }
    }
}

kotlin {
    jvmToolchain(17)
}

val bundleSyncEngine by tasks.registering(BundleSyncEngine::class) {
    node.set(nodeBinary)
    script.set(bundleScript)
    sources.from(engineSources, layout.projectDirectory.dir("js"))
    outputDir.set(bundleDir)
}

abstract class BundleSyncEngine : DefaultTask() {
    @get:Input abstract val node: Property<String>
    @get:InputFile @get:PathSensitive(PathSensitivity.RELATIVE) abstract val script: RegularFileProperty
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) abstract val sources: ConfigurableFileCollection
    @get:OutputDirectory abstract val outputDir: DirectoryProperty
    @get:Inject abstract val exec: ExecOperations

    @TaskAction
    fun bundle() {
        exec.exec {
            commandLine(node.get(), script.get().asFile.absolutePath, outputDir.get().file("sync-engine.js").asFile.absolutePath)
        }
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(bundleSyncEngine, BundleSyncEngine::outputDir)
    }
}

tasks.withType<Test>().configureEach { dependsOn(bundleSyncEngine) }

// Local unit tests run the same engine on the desktop JVM's QuickJS build.
configurations.matching { it.name.endsWith("UnitTestRuntimeClasspath") }.configureEach {
    resolutionStrategy.dependencySubstitution {
        substitute(module("io.github.dokar3:quickjs-kt-android"))
            .using(module("io.github.dokar3:quickjs-kt-jvm:${libs.versions.quickjs.get()}"))
    }
}

dependencies {
    api(libs.kotlinx.coroutines.core)
    implementation(libs.quickjs.android)
    implementation(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)

    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
}
