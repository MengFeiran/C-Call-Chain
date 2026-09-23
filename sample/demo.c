/* 测试用示例：用于验证 C 函数调用链插件 */

#include <stdio.h>

/* 最底层：被叶子函数调用 */
static int add(int a, int b)
{
    return a + b;
}

static int mul(int a, int b)
{
    return a * b;
}

/* 中间层：既被上层调用，又调用下层 */
static int calc(int a, int b)
{
    int s = add(a, b);      /* calc -> add */
    int m = mul(a, b);      /* calc -> mul */
    return s + m;
}

/* 顶层：调用 calc */
static void run(int x)
{
    int r = calc(x, 2);     /* run -> calc */
    printf("result = %d\n", r);
}

int main(void)
{
    run(10);                /* main -> run */
    return 0;
}
