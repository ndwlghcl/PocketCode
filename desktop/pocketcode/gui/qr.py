"""二维码渲染：qrcode 库出矩阵，QPainter 画到 QPixmap（不引入 PIL）。"""

from __future__ import annotations

import qrcode
import qrcode.constants
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPainter, QPixmap


def render_qr_pixmap(payload: str, cell_size: int = 6, margin_cells: int = 4) -> QPixmap:
    """把任意文本渲染成黑白二维码 QPixmap。"""
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(payload)
    qr.make(fit=True)
    matrix = qr.get_matrix()
    side = (len(matrix) + margin_cells * 2) * cell_size

    pixmap = QPixmap(side, side)
    pixmap.fill(QColor("white"))
    painter = QPainter(pixmap)
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(QColor("black"))
    offset = margin_cells * cell_size
    for row_index, row in enumerate(matrix):
        for col_index, dark in enumerate(row):
            if dark:
                painter.drawRect(
                    offset + col_index * cell_size,
                    offset + row_index * cell_size,
                    cell_size,
                    cell_size,
                )
    painter.end()
    return pixmap
