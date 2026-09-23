#include <stdio.h>
#include "util.h"

/* 跨文件调用：compute 在 app.c，add/mul 在 util.c */
static int compute(int x, int y)
{
    int s = CALC_TOTAL(x, y);   /* 经由嵌套宏间接调用 add / mul */
    return s;
}

int run_app(void)
{
    int r = compute(3, 4);
    printf("%d\n", r);
    return r;
}
