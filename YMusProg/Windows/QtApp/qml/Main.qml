import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ApplicationWindow {
    id: window
    width: 1248
    height: 704
    minimumWidth: 900
    minimumHeight: 560
    visible: true
    color: "#050505"
    title: "YMus"
    flags: Qt.Window | Qt.FramelessWindowHint | Qt.WindowSystemMenuHint | Qt.WindowMinimizeButtonHint | Qt.WindowMaximizeButtonHint

    property color yellow: "#ffd400"
    property bool lightTheme: backend.settings.theme === "Светлая"
    property color textColor: lightTheme ? "#1a1b1f" : "#f5f2e9"
    property color mutedColor: lightTheme ? "#6b6d77" : "#a8a8a8"
    property real t: 0
    property string currentPage: "Обзор"
    property bool compactLayout: width < 1040
    property int pageMargin: compactLayout ? 18 : 30
    property string minimizeTarget: "taskbar"
    property bool dragging: false

    function systemMove() {
        window.dragging = true
        window.startSystemMove()
        window.dragging = false
    }

    function systemResize(edges) {
        window.dragging = true
        window.startSystemResize(edges)
        window.dragging = false
    }

    function animatedMinimize(target) {
        minimizeTarget = target
        mainSurface.enabled = false
        minimizeAnimation.restart()
    }

    // Аврора рисуется через таймер на ~30fps, а не каждый кадр (60fps).
    // Это вдвое снижает нагрузку на GPU и убирает рывки при перетаскивании окна.
    Timer {
        id: auroraClock
        interval: 33
        repeat: true
        running: window.visible && !window.dragging
        onTriggered: {
            window.t += 0.0399
            if (window.t >= 6.283)
                window.t -= 6.283
            backgroundCanvas.requestPaint()
        }
    }

    Rectangle {
        anchors.fill: parent
        color: lightTheme ? "#eceef2" : "#090909"
    }

    Canvas {
        id: backgroundCanvas
        anchors.fill: parent
        opacity: 0.95
        renderTarget: Canvas.FramebufferObject
        renderStrategy: Canvas.Cooperative
        onPaint: {
            const ctx = getContext("2d")
            ctx.reset()

            // window.t анимируется 0..2π по кругу, поэтому целочисленные
            // множители скорости дают бесшовный цикл без рывка на стыке.
            const time = window.t
            const baseAlpha = window.lightTheme ? 0.3 : 1.0

            function blob(bx, by, br, alpha, hue, sx, sy, phase) {
                const dx = Math.sin(time * sx + phase) * width * 0.16
                const dy = Math.cos(time * sy + phase) * height * 0.16
                const x = width * bx + dx
                const y = height * by + dy
                const r = Math.max(width, height) * br
                const g = ctx.createRadialGradient(x, y, 0, x, y, r)
                g.addColorStop(0, "rgba(" + hue + "," + (alpha * baseAlpha) + ")")
                g.addColorStop(0.34, "rgba(" + hue + "," + (alpha * baseAlpha * 0.5) + ")")
                g.addColorStop(0.7, "rgba(" + hue + "," + (alpha * baseAlpha * 0.12) + ")")
                g.addColorStop(1, "rgba(255,212,0,0)")
                ctx.fillStyle = g
                ctx.beginPath()
                ctx.arc(x, y, r, 0, Math.PI * 2)
                ctx.fill()
            }

            ctx.globalCompositeOperation = "screen"
            ctx.filter = "blur(42px)"
            blob(0.18, 0.16, 0.42, 0.30, "255,212,0", 1, 1, 0.2)
            blob(0.78, 0.12, 0.36, 0.24, "255,241,128", 1, 2, 1.4)
            blob(0.85, 0.60, 0.44, 0.20, "255,154,0", 2, 1, 2.2)
            blob(0.12, 0.80, 0.34, 0.18, "255,212,0", 1, 1, 3.8)
            blob(0.48, 0.45, 0.50, 0.16, "255,224,70", 2, 2, 5.1)
            ctx.filter = "none"
            ctx.globalCompositeOperation = "source-over"

            const overlay = ctx.createLinearGradient(0, 0, 0, height)
            overlay.addColorStop(0, window.lightTheme ? "rgba(236,238,242,0.62)" : "rgba(9,9,9,0.42)")
            overlay.addColorStop(0.5, window.lightTheme ? "rgba(236,238,242,0.5)" : "rgba(9,9,9,0.16)")
            overlay.addColorStop(1, window.lightTheme ? "rgba(236,238,242,0.72)" : "rgba(9,9,9,0.66)")
            ctx.fillStyle = overlay
            ctx.fillRect(0, 0, width, height)
        }
    }

    RowLayout {
        id: mainSurface
        anchors.fill: parent
        spacing: 0
        transformOrigin: Item.Center

        Rectangle {
            Layout.preferredWidth: compactLayout ? 84 : 216
            Layout.fillHeight: true
            color: lightTheme ? "#ffffff" : "#90060606"
            border.color: lightTheme ? "#e2e4ea" : "#26303030"
            border.width: 1

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: compactLayout ? 16 : 22
                spacing: 0

                RowLayout {
                    Layout.preferredHeight: 58
                    spacing: 12

                    Rectangle {
                        Layout.preferredWidth: 50
                        Layout.preferredHeight: 50
                        radius: 14
                        color: "#101a1402"
                        border.color: "#ccffd400"
                        border.width: 2
                        Image {
                            anchors.centerIn: parent
                            width: 31
                            height: 31
                            source: assetsDir + "/app/Icon128x128.png"
                            smooth: true
                            mipmap: true
                            fillMode: Image.PreserveAspectFit
                        }
                    }
                }

                ColumnLayout {
                    Layout.topMargin: compactLayout ? 28 : 34
                    spacing: 12

                    NavItem {
                        iconSource: assetsDir + "/icons/overview.svg"
                        label: "Обзор"
                        showLabel: !window.compactLayout
                        active: window.currentPage === "Обзор"
                        onClicked: window.currentPage = "Обзор"
                    }
                    NavItem {
                        iconSource: assetsDir + "/icons/browsers.svg"
                        label: "Браузеры"
                        showLabel: !window.compactLayout
                        active: window.currentPage === "Браузеры"
                        onClicked: window.currentPage = "Браузеры"
                    }
                    NavItem {
                        iconSource: assetsDir + "/icons/settings.svg"
                        label: "Настройки"
                        showLabel: !window.compactLayout
                        active: window.currentPage === "Настройки"
                        onClicked: window.currentPage = "Настройки"
                    }
                    NavItem {
                        iconSource: assetsDir + "/icons/logs.svg"
                        label: "Журнал"
                        showLabel: !window.compactLayout
                        active: window.currentPage === "Журнал"
                        onClicked: window.currentPage = "Журнал"
                    }
                }

                Item { Layout.fillHeight: true }
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 68
                color: lightTheme ? "#ffffff" : "#560b0b0b"
                border.color: lightTheme ? "#e2e4ea" : "#26303030"
                border.width: 1

                MouseArea {
                    anchors.fill: parent
                    acceptedButtons: Qt.LeftButton
                    onPressed: window.systemMove()
                }

                RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 30
                    anchors.rightMargin: 22
                    spacing: 14

                    Item { Layout.fillWidth: true }
                    GlassButton {
                        text: "Проверить обновления"
                        textColor: yellow
                        preferredWidth: 178
                        onClicked: backend.check_updates()
                    }
                    Rectangle { Layout.preferredWidth: 1; Layout.preferredHeight: 30; color: "#303030" }
                    WindowButton { kind: "minimize"; onActionClicked: window.animatedMinimize("taskbar") }
                    WindowButton { kind: window.visibility === Window.Maximized ? "restore" : "maximize"; onActionClicked: window.visibility === Window.Maximized ? window.showNormal() : window.showMaximized() }
                    WindowButton { kind: "close"; danger: true; onActionClicked: backend.settings.minimizeToTray ? window.animatedMinimize("tray") : Qt.quit() }
                }
            }

            Loader {
                id: pageLoader
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.margins: window.pageMargin
                Layout.topMargin: compactLayout ? 16 : 22
                sourceComponent: window.currentPage === "Обзор" ? overviewPage
                    : window.currentPage === "Браузеры" ? browsersPage
                    : window.currentPage === "Журнал" ? logsPage
                    : settingsPage
                onLoaded: {
                    if (!item) return
                    item.opacity = 0.2
                    item.scale = 0.982
                    item.x = window.currentPage === "Обзор" ? -16 : 16
                    pageFade.target = item
                    pageScale.target = item
                    pageSlide.target = item
                    pageFade.restart()
                    pageScale.restart()
                    pageSlide.restart()
                }
                NumberAnimation { id: pageFade; property: "opacity"; from: 0.2; to: 1; duration: 260; easing.type: Easing.OutCubic }
                NumberAnimation { id: pageScale; property: "scale"; from: 0.982; to: 1; duration: 300; easing.type: Easing.OutBack }
                NumberAnimation { id: pageSlide; property: "x"; to: 0; duration: 300; easing.type: Easing.OutCubic }
            }
        }
    }

    Rectangle {
        id: toast
        width: Math.min(420, parent.width - 80)
        height: 48
        radius: 14
        z: 18
        opacity: 0
        visible: opacity > 0
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.rightMargin: 26
        anchors.topMargin: 82
        color: lightTheme ? "#ffffff" : "#d9121212"
        border.color: "#66ffd400"
        border.width: 1

        Behavior on opacity { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }

        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: 16
            anchors.rightMargin: 16
            spacing: 10
            Rectangle { Layout.preferredWidth: 8; Layout.preferredHeight: 8; radius: 4; color: yellow }
            Text {
                text: backend.status
                color: textColor
                font.pixelSize: 13
                font.bold: true
                elide: Text.ElideRight
                Layout.fillWidth: true
            }
        }
    }

    Timer {
        id: toastTimer
        interval: 2600
        repeat: false
        onTriggered: toast.opacity = 0
    }

    Connections {
        target: backend
        function onStatusChanged() {
            if (splash.opacity > 0.05) return
            toast.opacity = 1
            toastTimer.restart()
        }
    }

    SequentialAnimation {
        id: minimizeAnimation
        ParallelAnimation {
            NumberAnimation { target: mainSurface; property: "opacity"; from: 1; to: 0; duration: 155; easing.type: Easing.InCubic }
            NumberAnimation { target: mainSurface; property: "scale"; from: 1; to: 0.972; duration: 155; easing.type: Easing.InCubic }
        }
        ScriptAction {
            script: {
                if (window.minimizeTarget === "tray") {
                    window.hide()
                } else {
                    window.showMinimized()
                }
                mainSurface.opacity = 1
                mainSurface.scale = 1
                mainSurface.enabled = true
            }
        }
    }

    Component {
        id: overviewPage

        Item {
            anchors.fill: parent

            OverviewPanel {
                anchors.fill: parent
            }
        }
    }

    Component {
        id: settingsPage

        ScrollView {
            id: settingsScroll
            anchors.fill: parent
            clip: true
            contentWidth: availableWidth

            ColumnLayout {
                width: settingsScroll.availableWidth
                spacing: 18

                ColumnLayout {
                    spacing: 6
                    Text { text: "Настройки"; color: textColor; font.pixelSize: 28; font.bold: true }
                    Text { text: "Управление установкой, обновлениями и поведением программы."; color: mutedColor; font.pixelSize: 12 }
                }

                SettingsPanel {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 470
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 66
                    radius: 10
                    color: lightTheme ? "#ffffff" : "#b20f0f0f"
                    border.color: lightTheme ? "#e2e4ea" : "#303030"
                    RowLayout {
                        anchors.fill: parent
                        anchors.margins: 18
                        spacing: 18
                        PrimaryButton { text: "Сохранить изменения"; onClicked: backend.save_settings() }
                        GlassButton { text: "Отменить"; preferredWidth: 150 }
                        Item { Layout.fillWidth: true }
                        Text { text: backend.status; color: mutedColor; font.pixelSize: 12 }
                    }
                }
            }
        }
    }

    Component {
        id: browsersPage

        Item {
            anchors.fill: parent

            BrowserPanel {
                anchors.fill: parent
            }
        }
    }

    Component {
        id: logsPage

        ColumnLayout {
            anchors.fill: parent
            spacing: 18

            ColumnLayout {
                spacing: 6
                Text { text: "Журнал"; color: textColor; font.pixelSize: 28; font.bold: true }
                Text { text: "Последние действия установщика и диагностические сообщения."; color: mutedColor; font.pixelSize: 12 }
            }

            LogPanel {
                Layout.fillWidth: true
                Layout.fillHeight: true
            }
        }
    }

    Item {
        anchors.fill: parent
        z: 15
        visible: window.visibility !== Window.Maximized

        MouseArea {
            width: 7
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            cursorShape: Qt.SizeHorCursor
            onPressed: window.systemResize(Qt.LeftEdge)
        }
        MouseArea {
            width: 7
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            cursorShape: Qt.SizeHorCursor
            onPressed: window.systemResize(Qt.RightEdge)
        }
        MouseArea {
            height: 7
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            cursorShape: Qt.SizeVerCursor
            onPressed: window.systemResize(Qt.TopEdge)
        }
        MouseArea {
            height: 7
            anchors.bottom: parent.bottom
            anchors.left: parent.left
            anchors.right: parent.right
            cursorShape: Qt.SizeVerCursor
            onPressed: window.systemResize(Qt.BottomEdge)
        }
        MouseArea {
            width: 14
            height: 14
            anchors.left: parent.left
            anchors.top: parent.top
            cursorShape: Qt.SizeFDiagCursor
            onPressed: window.systemResize(Qt.LeftEdge | Qt.TopEdge)
        }
        MouseArea {
            width: 14
            height: 14
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            cursorShape: Qt.SizeFDiagCursor
            onPressed: window.systemResize(Qt.RightEdge | Qt.BottomEdge)
        }
        MouseArea {
            width: 14
            height: 14
            anchors.right: parent.right
            anchors.top: parent.top
            cursorShape: Qt.SizeBDiagCursor
            onPressed: window.systemResize(Qt.RightEdge | Qt.TopEdge)
        }
        MouseArea {
            width: 14
            height: 14
            anchors.left: parent.left
            anchors.bottom: parent.bottom
            cursorShape: Qt.SizeBDiagCursor
            onPressed: window.systemResize(Qt.LeftEdge | Qt.BottomEdge)
        }
    }

    Rectangle {
        id: splash
        anchors.fill: parent
        color: "#f2050505"
        visible: opacity > 0
        opacity: 1
        z: 20

        Behavior on opacity { NumberAnimation { duration: 450; easing.type: Easing.OutCubic } }

        // Сплэш держится, пока бэкенд реально не загрузится (сигнал ready),
        // с страховочным таймером на случай, если ready не придёт.
        Connections { target: backend; function onReady() { splash.opacity = 0 } }
        Timer {
            interval: 6000
            running: true
            repeat: false
            onTriggered: splash.opacity = 0
        }

        Column {
            anchors.centerIn: parent
            spacing: 14

            Image {
                anchors.horizontalCenter: parent.horizontalCenter
                source: assetsDir + "/app/Icon128x128.png"
                sourceSize.width: 82
                sourceSize.height: 82
                smooth: true
                mipmap: true
                fillMode: Image.PreserveAspectFit
            }
            Text { anchors.horizontalCenter: parent.horizontalCenter; text: "YMus"; color: textColor; font.pixelSize: 32; font.bold: true }
            Text { anchors.horizontalCenter: parent.horizontalCenter; text: "Загружаем менеджер расширения"; color: mutedColor; font.pixelSize: 12 }
        }
    }
}
