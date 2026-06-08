import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Button {
    id: root
    property string kind: "minimize"
    property bool danger: false
    property bool lightTheme: backend.settings.theme === "Светлая"
    signal actionClicked()

    Layout.preferredWidth: 38
    Layout.preferredHeight: 34
    focusPolicy: Qt.NoFocus
    padding: 0
    text: ""

    contentItem: Canvas {
        id: iconCanvas
        anchors.fill: parent
        onPaint: {
            const ctx = getContext("2d")
            ctx.reset()
            const c = root.danger && root.hovered ? "#ffffff" : (root.hovered ? "#ffd400" : (root.lightTheme ? "#151515" : "#e9e5d9"))
            ctx.strokeStyle = c
            ctx.lineWidth = 1.65
            ctx.lineCap = "round"
            ctx.lineJoin = "round"

            if (root.kind === "minimize") {
                ctx.beginPath()
                ctx.moveTo(width / 2 - 6, height / 2 + 3)
                ctx.lineTo(width / 2 + 6, height / 2 + 3)
                ctx.stroke()
            } else if (root.kind === "maximize") {
                ctx.beginPath()
                ctx.strokeRect(width / 2 - 5.5, height / 2 - 5.5, 11, 11)
            } else if (root.kind === "restore") {
                ctx.beginPath()
                ctx.strokeRect(width / 2 - 3.5, height / 2 - 6.5, 9, 9)
                ctx.beginPath()
                ctx.strokeRect(width / 2 - 6.5, height / 2 - 3.5, 9, 9)
            } else {
                ctx.beginPath()
                ctx.moveTo(width / 2 - 5, height / 2 - 5)
                ctx.lineTo(width / 2 + 5, height / 2 + 5)
                ctx.moveTo(width / 2 + 5, height / 2 - 5)
                ctx.lineTo(width / 2 - 5, height / 2 + 5)
                ctx.stroke()
            }
        }
    }

    background: Rectangle {
        radius: 12
        color: root.danger && root.hovered ? "#d73333" : (root.down ? (root.lightTheme ? "#e2e4ea" : "#332a04") : (root.hovered ? (root.lightTheme ? "#eef0f4" : "#242006") : "#05000000"))
        border.color: root.danger && root.hovered ? "#ff6868" : (root.hovered ? (root.lightTheme ? "#d3d6de" : "#6d6000") : "#00343434")
        border.width: root.hovered ? 1 : 0
        Behavior on color { ColorAnimation { duration: 120 } }
        Behavior on border.color { ColorAnimation { duration: 120 } }
    }

    onHoveredChanged: iconCanvas.requestPaint()
    onDownChanged: iconCanvas.requestPaint()
    onClicked: actionClicked()
}
