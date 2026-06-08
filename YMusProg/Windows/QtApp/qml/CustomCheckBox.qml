import QtQuick
import QtQuick.Controls

Item {
    id: root
    property bool checked: false
    property bool enabledState: true
    property bool lightTheme: backend.settings.theme === "Светлая"
    signal toggled(bool checked)

    width: 22
    height: 22
    opacity: enabledState ? 1 : 0.42

    Rectangle {
        anchors.centerIn: parent
        width: 18
        height: 18
        radius: 5
        color: root.checked ? "#ffd400" : (root.lightTheme ? "#f4f5f8" : "#101010")
        border.color: root.checked ? "#ffd400" : (mouse.containsMouse ? (root.lightTheme ? "#caa400" : "#9f8b00") : (root.lightTheme ? "#c2c5cd" : "#4c4c4c"))
        border.width: 1

        Behavior on color { ColorAnimation { duration: 120 } }
        Behavior on border.color { ColorAnimation { duration: 120 } }

        Canvas {
            anchors.centerIn: parent
            width: 11
            height: 8
            visible: root.checked
            onPaint: {
                const ctx = getContext("2d")
                ctx.reset()
                ctx.strokeStyle = "#050505"
                ctx.lineWidth = 2
                ctx.lineCap = "round"
                ctx.lineJoin = "round"
                ctx.beginPath()
                ctx.moveTo(1, 4)
                ctx.lineTo(4, 7)
                ctx.lineTo(10, 1)
                ctx.stroke()
            }
        }
    }

    MouseArea {
        id: mouse
        anchors.fill: parent
        enabled: root.enabledState
        hoverEnabled: true
        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
        onClicked: {
            root.checked = !root.checked
            root.toggled(root.checked)
        }
    }
}
