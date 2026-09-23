#include <stdio.h>

typedef void (*handler_t)(int);

struct mm_heap_ops {
    handler_t func_ptr_a;
    handler_t func_ptr_b;
};

static void func_a(int x);
static void func_other(int x);

/* 指定初始化器注册（注册处变量：l2_bit_heap_ops / other_heap_ops） */
struct mm_heap_ops l2_bit_heap_ops = {
    .func_ptr_a = func_a,
};

struct mm_heap_ops other_heap_ops = {
    .func_ptr_a = func_a,
    .func_ptr_b = func_other,
};

/* 全局函数指针变量 */
void (*g_cb)(int);

static void func_a(int x)
{
    printf("func_a: %d\n", x);
}

static void func_other(int x)
{
    printf("func_other: %d\n", x);
}

static struct mm_heap_ops *heap_get_ops(int type)
{
    if (type == 1) {
        return &l2_bit_heap_ops;
    }
    return &other_heap_ops;
}

/* 通过返回的指针调用成员：变量与注册处不同，靠成员名 func_ptr_a 连接 */
static void invoke_a(int v)
{
    struct mm_heap_ops *ops = heap_get_ops(1);
    ops->func_ptr_a(v);
}

/* 直接用注册处的变量调用 */
static void invoke_b(int v)
{
    other_heap_ops.func_ptr_b(v);
}

static void register_cb(void)
{
    g_cb = func_a;
}

static void invoke_g(int v)
{
    g_cb(v);
}

int fnptr_main(void)
{
    register_cb();
    invoke_a(1);
    invoke_b(2);
    invoke_g(3);
    return 0;
}
