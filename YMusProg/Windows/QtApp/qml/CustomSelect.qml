import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ComboBox {
    id: root
    property int preferredWidth: 220
    property bool lightTheme: backend.settings.theme === "Светлая"

    Layout.preferredWidth: preferredWidth
    Layout.preferredHeight: 36
    focusPolicy: Qt.NoFocus
    font.pixelSize: 12
    font.bold: false

    contentItem: Text {
        text: root.displayText
        color: root.lightTheme ? "#171717" : "#f5f2e9"
        font: root.font
        verticalAlignment: Text.AlignVCenter
        leftPadding: 12
        rightPadding: 30
        elide: Text.ElideRight
    }

    indicator: Canvas {
        x: root.width - width - 12
        y: root.topPadding + (root.availableHeight - height) / 2
        width: 10
        height: 7
        onPaint: {
            const ctx = getContext("2d")
            ctx.reset()
            ctx.strokeStyle = root.hovered || root.popup.visible ? "#ffd400" : (root.lightTheme ? "#4d4d4d" : "#a8a8a8")
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.moveTo(1, 1)
            ctx.lineTo(5, 5)
            ctx.lineTo(9, 1)
            ctx.stroke()
        }
    }

    background: Rectangle {
        radius: 8
        color: root.lightTheme ? (root.popup.visible ? "#eef0f4" : (root.hovered ? "#eef0f4" : "#f4f5f8")) : (root.popup.visible ? "#191919" : (root.hovered ? "#171717" : "#121212"))
        border.color: root.popup.visible ? "#ffd400" : (root.hovered ? (root.lightTheme ? "#caa400" : "#8a7800") : (root.lightTheme ? "#d3d6de" : "#3b3b2c"))
        border.width: 1
        Behavior on color { ColorAnimation { duration: 120 } }
        Behavior on border.color { ColorAnimation { duration: 120 } }
    }

    delegate: ItemDelegate {
        width: root.width
        height: 34
        highlighted: root.highlightedIndex === index
        contentItem: Text {
            text: modelData
            color: highlighted ? "#050505" : (root.lightTheme ? "#171717" : "#f5f2e9")
            font.pixelSize: 12
            verticalAlignment: Text.AlignVCenter
            leftPadding: 10
        }
        background: Rectangle {
            color: highlighted ? "#ffd400" : (root.lightTheme ? (hovered ? "#eef0f4" : "#ffffff") : (hovered ? "#211d0b" : "#101010"))
        }
    }

    popup: Popup {
        y: root.height + 6
        width: root.width
        implicitHeight: contentItem.implicitHeight + 8
        padding: 4
        background: Rectangle {
            radius: 8
            color: root.lightTheme ? "#ffffff" : "#101010"
            border.color: root.lightTheme ? "#d3d6de" : "#5c5000"
            border.width: 1
        }
        contentItem: ListView {
            clip: true
            implicitHeight: contentHeight
            model: root.popup.visible ? root.delegateModel : null
            currentIndex: root.highlightedIndex
        }
    }
}
