plugins { java; kotlin("jvm") version "2.4.21" }
repositories {
    mavenCentral()
    maven("https://jitpack.io")
    maven("https://raw.githubusercontent.com/Suwayomi/Suwayomi-Server/android-jar/")
}
dependencies {
    implementation("de.femtopedia.dex2jar:dex-tools:2.4.38")
    implementation("net.dongliu:apk-parser:2.6.10")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    // Source WebView helpers use Dispatchers.Main. The browser JVM supplies
    // that dispatcher through the local android.os.Looper/Handler shim; no
    // Android device or desktop UI is introduced by this dependency.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json-okio:1.11.0")
    // Several published DEX extensions use ProtoNumber in their class
    // metadata. The server runtime already carries this serializer module;
    // include it in the browser host classpath as well.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-protobuf:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    implementation("com.squareup.okhttp3:logging-interceptor:5.5.0")
    implementation("com.squareup.okhttp3:okhttp-brotli:5.5.0")
    implementation("com.squareup.okhttp3:okhttp-zstd:5.5.0")
    implementation("com.squareup.zstd:zstd-kmp-jvm:0.4.0")
    implementation("com.squareup.zstd:zstd-kmp-okio-jvm:0.4.0")
    implementation("org.jsoup:jsoup:1.23.2")
    implementation("io.reactivex:rxjava:1.3.8")
    implementation("com.github.null2264.injekt:injekt-core:4135455a2a")
    implementation("com.github.Suwayomi:android-jar:1.0.0")
    implementation("com.fasterxml.jackson.core:jackson-annotations:2.22")
    implementation("org.json:json:20250517")
    implementation("org.slf4j:slf4j-api:2.0.20")
    // Android's ICU API is used by published extension parsers. The browser
    // host adapts that API package to the pure-Java ICU4J implementation.
    implementation("com.ibm.icu:icu4j:78.3")
}
java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
val prepareApi by tasks.registering(Sync::class) {
    into(layout.buildDirectory.dir("api-kotlin"))
    from("../../server/src/main/kotlin") {
        include("eu/kanade/tachiyomi/source/*.kt", "eu/kanade/tachiyomi/source/model/**", "eu/kanade/tachiyomi/source/online/**")
        include("eu/kanade/tachiyomi/network/Requests.kt", "eu/kanade/tachiyomi/network/OkHttpExtensions.kt", "eu/kanade/tachiyomi/network/ProgressListener.kt", "eu/kanade/tachiyomi/network/ProgressResponseBody.kt", "eu/kanade/tachiyomi/network/HttpException.kt")
        include("eu/kanade/tachiyomi/network/interceptor/UncaughtExceptionInterceptor.kt")
        include("eu/kanade/tachiyomi/network/interceptor/UserAgentInterceptor.kt")
        include("eu/kanade/tachiyomi/util/chapter/ChapterRecognition.kt")
        include("eu/kanade/tachiyomi/util/chapter/ChapterSanitizer.kt")
        include("eu/kanade/tachiyomi/util/JsoupExtensions.kt", "suwayomi/tachidesk/manga/impl/util/lang/RxCoroutineBridge.kt", "suwayomi/tachidesk/manga/impl/util/lang/JsonObject.kt")
    }
}
val prepareAndroid by tasks.registering(Sync::class) {
    into(layout.buildDirectory.dir("api-java"))
    from("../../AndroidCompat/src/main/java") {
        include("androidx/preference/**", "xyz/nulldev/androidcompat/io/sharedprefs/JsonSharedPreferences.java")
        include("android/content/SharedPreferences.java", "android/net/Uri.java", "libcore/net/UriCodec.java", "android/util/Log.java")
        include("android/annotation/**", "android/os/Parcelable.java", "android/util/Base64.java")
    }
}
kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17); freeCompilerArgs.add("-Xcontext-parameters") }
    sourceSets.main {
        kotlin.srcDir(prepareApi)
    }
}
sourceSets.main {
    java.srcDir(prepareAndroid)
}
// One fixed timestamp for every archive entry (declared in the tree), sorted entries: byte-reproducible output.
val sourceDateEpoch: Long = file("../SOURCE_DATE_EPOCH").readText().trim().toLong()
val unpatchedBrowserJar by tasks.registering(Jar::class) {
    dependsOn(tasks.classes)
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
    filePermissions { unix("rw-r--r--") }
    dirPermissions { unix("rwxr-xr-x") }
    archiveFileName.set("extension-host-unpatched.jar")
    destinationDirectory.set(layout.buildDirectory.dir("libs"))
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(sourceSets.main.get().output)
    from(layout.buildDirectory.dir("locale-provider-classes"))
    from(configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) })
    exclude("META-INF/*.SF", "META-INF/*.RSA", "META-INF/*.DSA", "module-info.class")
}
val compileBrowserLocaleProvider by tasks.registering(JavaCompile::class) {
    val sources = file("src/locale-provider/java")
    source(fileTree(sources) { include("**/*.java") })
    classpath = files()
    destinationDirectory.set(layout.buildDirectory.dir("locale-provider-classes"))
    sourceCompatibility = "17"
    targetCompatibility = "17"
    options.compilerArgs.add("--patch-module=java.base=${sources.absolutePath}")
}
unpatchedBrowserJar.configure { dependsOn(compileBrowserLocaleProvider) }
tasks.register<JavaExec>("browserJar") {
    dependsOn(unpatchedBrowserJar)
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("suwayomi.browser.PatchOkHttp")
    val output = file("../runtime/extension-host.jar")
    inputs.file(unpatchedBrowserJar.flatMap { it.archiveFile })
    outputs.file(output)
    doFirst { output.parentFile.mkdirs() }
    args(unpatchedBrowserJar.get().archiveFile.get().asFile.absolutePath, output.absolutePath, sourceDateEpoch.toString())
}
val extensionAuditApkDirectory = providers.gradleProperty("extensionAuditApkDirectory").orNull?.let(::file)
fun extensionAuditApkPaths(defaultDirectory: File): List<String> {
    val directory = extensionAuditApkDirectory ?: defaultDirectory
    require(directory.isDirectory) { "Extension APK audit directory does not exist: $directory" }
    val paths = fileTree(directory) { include("*.apk") }.files.sortedBy { it.name }.map { it.absolutePath }
    require(paths.isNotEmpty()) { "No APK files found for extension API audit in $directory" }
    return paths
}
tasks.register<JavaExec>("auditExtensionAndroidApi") {
    dependsOn(tasks.testClasses)
    classpath = sourceSets.test.get().runtimeClasspath
    mainClass.set("suwayomi.browser.ExtensionAndroidApiAudit")
    args = extensionAuditApkPaths(file("../test/fixtures"))
}
tasks.register<JavaExec>("auditExtensionHostApi") {
    dependsOn(tasks.testClasses)
    classpath = sourceSets.test.get().runtimeClasspath
    mainClass.set("suwayomi.browser.ExtensionHostApiAudit")
    args = extensionAuditApkPaths(file("../test/fixtures"))
}
tasks.register("writeRuntimeDependencyInventory") {
    val output = layout.buildDirectory.file("runtime-dependencies.tsv")
    inputs.files(configurations.runtimeClasspath)
    outputs.file(output)
    doLast {
        output.get().asFile.writeText(configurations.runtimeClasspath.get().resolvedConfiguration.resolvedArtifacts
            .sortedBy { it.moduleVersion.id.toString() }.joinToString("\n") { "${it.moduleVersion.id}\t${it.file.absolutePath}" })
    }
}
